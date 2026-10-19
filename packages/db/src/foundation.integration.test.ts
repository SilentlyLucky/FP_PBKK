import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseClient, schema, type DatabaseClient } from "./index.js";

const connectionString = process.env.PROMPTLAB_DATABASE_URL;
const integrationRequested =
  process.env.PROMPTLAB_INTEGRATION_TESTS === "1" && Boolean(connectionString);

describe.skipIf(!integrationRequested)(
  "PostgreSQL foundation integration",
  () => {
    let client: DatabaseClient | undefined;
    let projectId: string | undefined;
    let otherProjectId: string | undefined;

    beforeAll(async () => {
      const target = new URL(connectionString!);
      if (
        target.hostname !== "127.0.0.1" ||
        target.port !== "56432" ||
        target.pathname !== "/promptlab"
      ) {
        throw new Error(
          "Integration tests require disposable docker-compose.integration.yml on loopback port 56432.",
        );
      }

      const connected = createDatabaseClient(connectionString!);
      client = connected;
      const tables = await connected.pool.query<{ count: string }>(
        `select count(*)::text as count from pg_tables
       where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
      );
      if (tables.rows[0]?.count !== "22") {
        throw new Error(
          "Integration tests require all 22 foundation tables from the reviewed migration.",
        );
      }
    }, 15_000);

    afterAll(async () => {
      const connected = client;
      if (!connected) return;
      if (projectId) {
        await connected.db
          .update(schema.prompts)
          .set({ currentVersionId: null })
          .where(eq(schema.prompts.projectId, projectId));
        await connected.db
          .delete(schema.projects)
          .where(eq(schema.projects.id, projectId));
      }
      if (otherProjectId) {
        await connected.db
          .update(schema.prompts)
          .set({ currentVersionId: null })
          .where(eq(schema.prompts.projectId, otherProjectId));
        await connected.db
          .delete(schema.projects)
          .where(eq(schema.projects.id, otherProjectId));
      }
      await connected.pool.end();
    });

    it("enforces project scope and stores source evidence, staged snapshots, events, outbox, and unknown usage", async () => {
      if (!client) throw new Error("Database integration setup did not run.");
      const unique = randomUUID();
      const [project] = await client.db
        .insert(schema.projects)
        .values({
          ownerId: `integration-${unique}`,
          name: `foundation-${unique}`,
        })
        .returning({ id: schema.projects.id });
      const [otherProject] = await client.db
        .insert(schema.projects)
        .values({
          ownerId: `integration-${unique}`,
          name: `other-${unique}`,
        })
        .returning({ id: schema.projects.id });
      if (!project || !otherProject) throw new Error("Project insert failed.");
      projectId = project.id;
      otherProjectId = otherProject.id;

      const [prompt] = await client.db
        .insert(schema.prompts)
        .values({ projectId, name: "Integration prompt" })
        .returning({ id: schema.prompts.id });
      if (!prompt) throw new Error("Prompt insert failed.");
      const [versionOne] = await client.db
        .insert(schema.promptVersions)
        .values({
          projectId,
          promptId: prompt.id,
          version: 1,
          text: "Use cited evidence.",
          contentHash: "a".repeat(64),
          invariantHash: "b".repeat(64),
        })
        .returning({ id: schema.promptVersions.id });
      if (!versionOne) throw new Error("Prompt version insert failed.");
      await client.db
        .update(schema.prompts)
        .set({ currentVersionId: versionOne.id })
        .where(
          and(
            eq(schema.prompts.projectId, projectId),
            eq(schema.prompts.id, prompt.id),
          ),
        );
      const [versionTwo] = await client.db
        .insert(schema.promptVersions)
        .values({
          projectId,
          promptId: prompt.id,
          version: 2,
          parentVersionId: versionOne.id,
          text: "Use cited evidence and label unknowns.",
          contentHash: "c".repeat(64),
          invariantHash: "b".repeat(64),
        })
        .returning({ id: schema.promptVersions.id });
      if (!versionTwo) throw new Error("Second prompt version insert failed.");

      await expect(
        client.db.insert(schema.promptVersions).values({
          projectId: otherProjectId,
          promptId: prompt.id,
          version: 1,
          text: "Cross-project reference must be rejected.",
          contentHash: "d".repeat(64),
          invariantHash: "b".repeat(64),
        }),
      ).rejects.toMatchObject({ cause: { code: "23503" } });

      const [document] = await client.db
        .insert(schema.documents)
        .values({
          projectId,
          displayName: "Source fixture",
          sourceKind: "text",
        })
        .returning({ id: schema.documents.id });
      if (!document) throw new Error("Document insert failed.");
      const [documentVersion] = await client.db
        .insert(schema.documentVersions)
        .values({
          projectId,
          documentId: document.id,
          version: 1,
          checksum: "e".repeat(64),
          contentType: "text/plain",
        })
        .returning({ id: schema.documentVersions.id });
      if (!documentVersion) throw new Error("Document version insert failed.");
      const [chunk] = await client.db
        .insert(schema.chunks)
        .values({
          projectId,
          documentVersionId: documentVersion.id,
          ordinal: 0,
          content: "Service Checkout uses Queue Order.",
          contentHash: "f".repeat(64),
        })
        .returning({ id: schema.chunks.id });
      if (!chunk) throw new Error("Chunk insert failed.");

      const [build] = await client.db
        .insert(schema.graphBuilds)
        .values({
          projectId,
          sourceManifest: [{ documentVersionId: documentVersion.id }],
          sourceManifestHash: "1".repeat(64),
          extractionPromptVersion: "integration-prompt-v1",
          extractionSchemaVersion: "integration-schema-v1",
        })
        .returning({ id: schema.graphBuilds.id });
      if (!build) throw new Error("Graph build insert failed.");
      const [snapshot] = await client.db
        .insert(schema.graphSnapshots)
        .values({
          projectId,
          buildId: build.id,
          sourceManifest: [{ documentVersionId: documentVersion.id }],
          sourceManifestHash: "1".repeat(64),
          state: "staging",
        })
        .returning({ id: schema.graphSnapshots.id });
      if (!snapshot) throw new Error("Graph snapshot insert failed.");

      const [subject] = await client.db
        .insert(schema.graphEntities)
        .values({
          projectId,
          canonicalLabel: "Service Checkout",
          entityType: "service",
          normalizedLabel: "service checkout",
        })
        .returning({ id: schema.graphEntities.id });
      const [object] = await client.db
        .insert(schema.graphEntities)
        .values({
          projectId,
          canonicalLabel: "Queue Order",
          entityType: "queue",
          normalizedLabel: "queue order",
        })
        .returning({ id: schema.graphEntities.id });
      if (!subject || !object) throw new Error("Graph entity insert failed.");
      const [assertion] = await client.db
        .insert(schema.graphAssertions)
        .values({
          projectId,
          subjectEntityId: subject.id,
          predicate: "uses",
          objectEntityId: object.id,
          status: "needs_review",
        })
        .returning({ id: schema.graphAssertions.id });
      if (!assertion) throw new Error("Graph assertion insert failed.");
      const [assertionVersion] = await client.db
        .insert(schema.graphAssertionVersions)
        .values({
          projectId,
          assertionId: assertion.id,
          version: 1,
          subjectEntityId: subject.id,
          predicate: "uses",
          objectEntityId: object.id,
          direction: "directed",
          status: "needs_review",
        })
        .returning({ id: schema.graphAssertionVersions.id });
      if (!assertionVersion)
        throw new Error("Graph assertion version insert failed.");
      await client.db.insert(schema.graphEvidence).values({
        projectId,
        assertionId: assertion.id,
        assertionVersionId: assertionVersion.id,
        documentVersionId: documentVersion.id,
        chunkId: chunk.id,
        quote: "Service Checkout uses Queue Order.",
        spanStart: 0,
        spanEnd: 35,
        sourceChecksum: "e".repeat(64),
      });
      await client.db.insert(schema.graphSnapshotAssertions).values({
        projectId,
        snapshotId: snapshot.id,
        assertionId: assertion.id,
        assertionVersionId: assertionVersion.id,
        sourceManifestHash: "1".repeat(64),
      });
      await client.db.insert(schema.graphActiveSnapshots).values({
        projectId,
        snapshotId: snapshot.id,
      });
      await client.db.insert(schema.graphQueryTraces).values({
        projectId,
        snapshotId: snapshot.id,
        bounds: { maxHops: 2, maxEdges: 60 },
      });

      const [run] = await client.db
        .insert(schema.runs)
        .values({
          projectId,
          promptVersionId: versionTwo.id,
          purpose: "target",
          provider: "campus_gateway",
          requestedModel: "local-integration-only",
          idempotencyKey: `integration-${unique}`,
        })
        .returning({ id: schema.runs.id });
      if (!run) throw new Error("Run insert failed.");
      await client.db.insert(schema.runEvents).values({
        projectId,
        runId: run.id,
        sequence: 1,
        eventType: "run.status",
        payload: { status: "created" },
      });
      await client.db.insert(schema.outbox).values({
        projectId,
        aggregateId: run.id,
        eventType: "run.enqueue",
        payload: { projectId, runId: run.id },
      });
      await client.db.insert(schema.usageRecords).values({
        projectId,
        runId: run.id,
        provider: "campus_gateway",
        purpose: "target",
        provenance: "unknown",
        completeness: "unknown",
        mapperVersion: "integration-v1",
      });

      const [storedUsage] = await client.db
        .select({
          inputTokens: schema.usageRecords.inputTokens,
          outputTokens: schema.usageRecords.outputTokens,
          provenance: schema.usageRecords.provenance,
        })
        .from(schema.usageRecords)
        .where(eq(schema.usageRecords.runId, run.id));
      const storedEvents = await client.db
        .select({ sequence: schema.runEvents.sequence })
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, run.id));
      const storedOutbox = await client.db
        .select({ eventType: schema.outbox.eventType })
        .from(schema.outbox)
        .where(eq(schema.outbox.aggregateId, run.id));

      expect(storedUsage).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        provenance: "unknown",
      });
      expect(storedEvents.map((event) => event.sequence)).toEqual([1]);
      expect(storedOutbox.map((event) => event.eventType)).toEqual([
        "run.enqueue",
      ]);
    }, 20_000);
  },
);
