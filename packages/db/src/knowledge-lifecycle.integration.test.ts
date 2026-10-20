import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  createKnowledgeSource,
  deleteKnowledgeSource,
  getKnowledgeSource,
  getActiveKnowledgeMarkdownStructure,
  getActiveGraphSnapshot,
  graphSnapshotIsCurrent,
  importKnowledgeReferencePack,
  listActiveGraphAssertions,
  listKnowledgeSources,
  previewGraphBuild,
  replaceKnowledgeSource,
  reviewGraphAssertion,
  retrieveKnowledgeContext,
  schema,
  setKnowledgeSourcePermission,
  type DatabaseClient,
} from "./index.js";

const connectionString = process.env.PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL;
const integrationRequested =
  process.env.PROMPTLAB_KNOWLEDGE_LIFECYCLE_INTEGRATION_TESTS === "1" &&
  Boolean(connectionString);

const requiredTables = [
  "projects",
  "documents",
  "document_versions",
  "chunks",
  "graph_builds",
  "graph_snapshots",
  "graph_entities",
  "graph_assertions",
  "graph_assertion_versions",
  "graph_evidence",
  "graph_snapshot_assertions",
  "graph_active_snapshots",
  "graph_query_traces",
];

const projectIds: string[] = [];

describe.skipIf(!integrationRequested)(
  "Knowledge lifecycle integration",
  () => {
    let client: DatabaseClient | undefined;

    beforeAll(async () => {
      const target = new URL(connectionString!);
      const databaseName = decodeURIComponent(
        target.pathname.replace(/^\/+/, ""),
      );
      if (
        !["127.0.0.1", "localhost"].includes(target.hostname) ||
        target.port !== "56432" ||
        !/^promptlab_knowledge_test_[a-f0-9]{32}$/iu.test(databaseName)
      ) {
        throw new Error(
          "Knowledge lifecycle integration tests require a disposable UUID-named database on loopback port 56432, configured with PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL.",
        );
      }

      const connected = createDatabaseClient(connectionString!);
      client = connected;
      const tables = await connected.pool.query<{ tablename: string }>(
        `select tablename from pg_tables
       where schemaname = 'public' and tablename = any($1::text[])`,
        [requiredTables],
      );
      const presentTables = new Set(tables.rows.map((row) => row.tablename));
      const missingTables = requiredTables.filter(
        (table) => !presentTables.has(table),
      );
      if (missingTables.length) {
        throw new Error(
          `Knowledge lifecycle integration database is missing migrated tables: ${missingTables.join(", ")}.`,
        );
      }
    }, 15_000);

    afterAll(async () => {
      const connected = client;
      if (!connected) return;
      if (projectIds.length) {
        await connected.db
          .delete(schema.projects)
          .where(inArray(schema.projects.id, projectIds));
      }
      await connected.pool.end();
    });

    it("preserves quote evidence when accepting an assertion", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);
      const fixture = await createGraphFixture(connected, projectId);

      const reviewed = await reviewGraphAssertion(connected.db, {
        projectId,
        assertionId: fixture.assertionId,
        version: 1,
        decision: "accept",
        reason: "Integration review acceptance.",
      });

      expect(reviewed).toMatchObject({
        version: 2,
        status: "extracted_supported",
      });
      const listing = await listActiveGraphAssertions(connected.db, projectId);
      const assertion = listing.assertions.find(
        (item) => item.id === fixture.assertionId,
      );
      expect(assertion).toMatchObject({
        version: 2,
        status: "extracted_supported",
      });
      expect(assertion?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ quote: fixture.quote }),
        ]),
      );

      const retrieval = await retrieveKnowledgeContext(connected.db, {
        projectId,
        query: "What does Service Checkout use?",
        strategy: "graph",
        sourceIds: [fixture.sourceId],
      });
      expect(retrieval.strategyUsed).toBe("graph");
      expect(retrieval.evidence.map((item) => item.quote)).toContain(
        fixture.quote,
      );
    }, 20_000);

    it("rejects review when the active snapshot source manifest is stale", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);
      const fixture = await createGraphFixture(connected, projectId);

      expect(
        await graphSnapshotIsCurrent(
          connected.db,
          projectId,
          fixture.sourceManifest,
        ),
      ).toBe(true);
      await setKnowledgeSourcePermission(
        connected.db,
        projectId,
        fixture.sourceId,
        "local_only",
      );
      const downgradedSnapshot = await getActiveGraphSnapshot(
        connected.db,
        projectId,
      );
      expect(downgradedSnapshot?.state).toBe("stale");
      expect(
        await graphSnapshotIsCurrent(
          connected.db,
          projectId,
          fixture.sourceManifest,
        ),
      ).toBe(false);

      await expect(
        reviewGraphAssertion(connected.db, {
          projectId,
          assertionId: fixture.assertionId,
          version: 1,
          decision: "accept",
          reason: "This review must not activate a stale manifest.",
        }),
      ).rejects.toThrow();

      const active = await getActiveGraphSnapshot(connected.db, projectId);
      expect(active?.snapshotId).toBe(fixture.snapshotId);
      const [assertion] = await connected.db
        .select({ currentVersion: schema.graphAssertions.currentVersion })
        .from(schema.graphAssertions)
        .where(
          and(
            eq(schema.graphAssertions.projectId, projectId),
            eq(schema.graphAssertions.id, fixture.assertionId),
          ),
        );
      expect(assertion?.currentVersion).toBe(1);
    }, 20_000);

    it("invalidates graph evidence and snapshot freshness after a source update", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);
      const fixture = await createGraphFixture(connected, projectId);

      const updated = await replaceKnowledgeSource(connected.db, {
        projectId,
        sourceId: fixture.sourceId,
        displayName: "Knowledge lifecycle source",
        content: "Service Checkout now uses a replacement queue.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      expect(updated.version).toBe(2);
      expect(
        await graphSnapshotIsCurrent(
          connected.db,
          projectId,
          fixture.sourceManifest,
        ),
      ).toBe(false);
      const [evidence] = await connected.db
        .select({ eligible: schema.graphEvidence.eligible })
        .from(schema.graphEvidence)
        .where(
          and(
            eq(schema.graphEvidence.projectId, projectId),
            eq(schema.graphEvidence.assertionId, fixture.assertionId),
          ),
        );
      expect(evidence?.eligible).toBe(false);
    }, 20_000);

    it("invalidates graph evidence and snapshot freshness after source deletion", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);
      const fixture = await createGraphFixture(connected, projectId);

      await deleteKnowledgeSource(connected.db, projectId, fixture.sourceId);
      expect(
        await graphSnapshotIsCurrent(
          connected.db,
          projectId,
          fixture.sourceManifest,
        ),
      ).toBe(false);
      const [evidence] = await connected.db
        .select({ eligible: schema.graphEvidence.eligible })
        .from(schema.graphEvidence)
        .where(
          and(
            eq(schema.graphEvidence.projectId, projectId),
            eq(schema.graphEvidence.assertionId, fixture.assertionId),
          ),
        );
      expect(evidence?.eligible).toBe(false);
    }, 20_000);

    it("keeps evidence ineligible after a same-content permission revocation", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);
      const fixture = await createGraphFixture(connected, projectId);

      const sourceInput = {
        projectId,
        sourceId: fixture.sourceId,
        displayName: "Knowledge lifecycle source",
        content: fixture.quote,
        contentType: "text/plain" as const,
        sourceKind: "paste" as const,
      };
      await replaceKnowledgeSource(connected.db, {
        ...sourceInput,
        permission: "local_only",
      });
      const downgradedSnapshot = await getActiveGraphSnapshot(
        connected.db,
        projectId,
      );
      expect(downgradedSnapshot?.state).toBe("stale");
      const [revokedEvidence] = await connected.db
        .select({ eligible: schema.graphEvidence.eligible })
        .from(schema.graphEvidence)
        .where(
          and(
            eq(schema.graphEvidence.projectId, projectId),
            eq(schema.graphEvidence.assertionId, fixture.assertionId),
          ),
        );
      await replaceKnowledgeSource(connected.db, {
        ...sourceInput,
        permission: "campus_indexer_allowed",
      });

      const [evidence] = await connected.db
        .select({ eligible: schema.graphEvidence.eligible })
        .from(schema.graphEvidence)
        .where(
          and(
            eq(schema.graphEvidence.projectId, projectId),
            eq(schema.graphEvidence.assertionId, fixture.assertionId),
          ),
        );
      expect(revokedEvidence?.eligible).toBe(false);
      expect(evidence?.eligible).toBe(false);
    }, 20_000);

    it("imports the fixed public pack for indexing and keeps repeat imports idempotent", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);

      const first = await importKnowledgeReferencePack(connected.db, projectId);
      expect(first).toMatchObject({
        imported: 9,
        skipped: 0,
        packId: "promptlab-general-knowledge-seed-2026-10",
      });
      expect(first.documentIds).toHaveLength(9);

      const listed = await listKnowledgeSources(connected.db, projectId);
      expect(listed).toHaveLength(9);
      expect(
        listed.every(
          (source) => source.permission === "campus_indexer_allowed",
        ),
      ).toBe(true);
      expect(
        listed.every((source) => source.sourceKind === "curated_reference"),
      ).toBe(true);
      expect(
        listed.reduce((count, source) => count + source.chunkCount, 0),
      ).toBe(10);
      const prompting = listed.find(
        (source) => source.sourceMetadata.source_id === "openai-prompting",
      );
      expect(prompting?.sourceRef).toBe(
        "https://developers.openai.com/api/docs/guides/prompting",
      );
      expect(prompting?.sourceMetadata).toMatchObject({
        publisher: "OpenAI",
        accessed_at_utc: "2026-10-15T03:11:37Z",
      });
      if (!prompting) throw new Error("Prompting source was not imported.");

      const detail = await getKnowledgeSource(
        connected.db,
        projectId,
        prompting.id,
      );
      expect(detail.chunks).toHaveLength(1);
      expect(detail.chunks[0]?.content).toContain(
        "Run your prompt tests and evaluation cases every time you publish.",
      );
      const firstVersion = detail.version;

      const retrieval = await retrieveKnowledgeContext(connected.db, {
        projectId,
        query: "prompt tests evaluation cases",
        strategy: "lexical",
        sourceIds: [prompting.id],
      });
      expect(retrieval.evidence[0]).toMatchObject({
        sourceRef: prompting.sourceRef,
        sourceMetadata: { publisher: "OpenAI" },
        documentVersion: firstVersion,
      });
      expect(retrieval.packedContext).toContain(prompting.sourceRef);

      const second = await importKnowledgeReferencePack(connected.db, projectId);
      expect(second).toMatchObject({
        imported: 0,
        skipped: 9,
        packId: first.packId,
      });
      expect(second.documentIds).toEqual(first.documentIds);
      const unchanged = await getKnowledgeSource(
        connected.db,
        projectId,
        prompting.id,
      );
      expect(unchanged.version).toBe(firstVersion);
      expect(unchanged.checksum).toBe(detail.checksum);

      const metadataVersion = await replaceKnowledgeSource(connected.db, {
        projectId,
        sourceId: prompting.id,
        displayName: prompting.displayName,
        content: detail.chunks.map((chunk) => chunk.content).join("\n\n"),
        contentType: "text/markdown",
        sourceKind: "reference_pack",
        permission: "local_only",
        sourceRef: prompting.sourceRef,
        sourceMetadata: {
          ...detail.sourceMetadata,
          metadataRevisionFixture: "version-check",
        },
      });
      expect(metadataVersion.version).toBe(firstVersion + 1);
      expect(metadataVersion.checksum).toBe(detail.checksum);
    }, 30_000);

    it("preserves source URLs and PDF page provenance through retrieval", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);
      const pages = [
        { pageNumber: 1, content: "First PDF page source." },
        { pageNumber: 2, content: "Second PDF page source." },
      ];
      const source = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "page-provenance.pdf",
        content: pages.map((page) => page.content).join("\n\n"),
        contentType: "application/pdf",
        sourceKind: "upload",
        permission: "local_only",
        sourceRef: "https://example.org/page-provenance.pdf",
        pages,
      });
      const detail = await getKnowledgeSource(
        connected.db,
        projectId,
        source.sourceId,
      );
      expect(detail.sourceRef).toBe("https://example.org/page-provenance.pdf");
      expect(detail.chunks.map((chunk) => chunk.pageNumber)).toEqual([1, 2]);
      const sources = await listKnowledgeSources(connected.db, projectId);
      expect(
        sources.find((item) => item.id === source.sourceId)?.sourceRef,
      ).toBe(detail.sourceRef);

      const retrieval = await retrieveKnowledgeContext(connected.db, {
        projectId,
        query: "Second PDF page source",
        strategy: "lexical",
        sourceIds: [source.sourceId],
      });
      expect(retrieval.evidence[0]).toMatchObject({
        sourceRef: detail.sourceRef,
        documentVersion: 1,
        pageNumber: 2,
      });
      expect(retrieval.packedContext).toContain(
        "https://example.org/page-provenance.pdf",
      );
    }, 20_000);

    it("resolves imported Markdown links within the project and vault namespace", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);
      const otherProjectId = await createProject(connected);
      const markdown =
        "\uFEFF# Index\n\n[[notes/Target#Guide|Target guide]]\n[Shared](../shared/guide.md#Start)\n[[Same]]\n[[Missing]]\n[[PrivateOnly]]\n[[CrossProject]]";
      const index = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Index.md",
        content: markdown,
        contentType: "text/markdown",
        sourceKind: "paste",
        permission: "local_only",
        sourceRef: "https://example.org/index",
        vaultLocator: { namespace: "main", path: "notes/Index.md" },
      });
      const target = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Target.md",
        content: "# Guide\nOriginal version",
        contentType: "text/markdown",
        sourceKind: "paste",
        permission: "local_only",
        vaultLocator: { namespace: "main", path: "notes/Target.md" },
      });
      await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Shared guide.md",
        content: "# Start\nShared note",
        contentType: "text/markdown",
        sourceKind: "paste",
        permission: "local_only",
        vaultLocator: { namespace: "main", path: "shared/guide.md" },
      });
      await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Same A.md",
        content: "Duplicate basename A",
        contentType: "text/markdown",
        sourceKind: "paste",
        permission: "local_only",
        vaultLocator: { namespace: "main", path: "a/Same.md" },
      });
      await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Same B.md",
        content: "Duplicate basename B",
        contentType: "text/markdown",
        sourceKind: "paste",
        permission: "local_only",
        vaultLocator: { namespace: "main", path: "b/Same.markdown" },
      });
      await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "PrivateOnly.md",
        content: "Other vault note",
        contentType: "text/markdown",
        sourceKind: "paste",
        permission: "local_only",
        vaultLocator: { namespace: "private", path: "PrivateOnly.md" },
      });
      await createKnowledgeSource(connected.db, {
        projectId: otherProjectId,
        displayName: "CrossProject.md",
        content: "Other project note",
        contentType: "text/markdown",
        sourceKind: "paste",
        permission: "local_only",
        vaultLocator: { namespace: "main", path: "CrossProject.md" },
      });

      const first = await getActiveKnowledgeMarkdownStructure(
        connected.db,
        projectId,
      );
      const firstLinks = first.links.filter(
        (link) => link.sourceDocumentId === index.sourceId,
      );
      const targetLink = firstLinks.find(
        (link) => link.link.rawTarget === "notes/Target#Guide",
      );
      expect(targetLink).toMatchObject({
        targetDocumentId: target.sourceId,
        targetDocumentVersionId: target.versionId,
        link: {
          syntax: "obsidian",
          anchor: "Guide",
          alias: "Target guide",
          resolution: { status: "resolved", method: "path" },
        },
      });
      expect(
        firstLinks.find((link) => link.link.label === "Shared"),
      ).toMatchObject({
        targetPath: "shared/guide.md",
        link: {
          syntax: "markdown",
          anchor: "Start",
          resolution: { status: "resolved", method: "path" },
        },
      });
      expect(
        firstLinks.find((link) => link.link.rawTarget === "Same")?.link
          .resolution,
      ).toMatchObject({ status: "ambiguous", method: "basename" });
      for (const rawTarget of ["Missing", "PrivateOnly", "CrossProject"]) {
        expect(
          firstLinks.find((link) => link.link.rawTarget === rawTarget)?.link
            .resolution,
        ).toMatchObject({ status: "unresolved" });
      }

      const sourceDetail = await getKnowledgeSource(
        connected.db,
        projectId,
        index.sourceId,
      );
      expect(sourceDetail.chunks).toHaveLength(1);
      expect(sourceDetail.chunks[0]?.content).toBe(markdown);
      expect(sourceDetail.sourceRef).toBe("https://example.org/index");
      expect(sourceDetail.sourceMetadata).toMatchObject({
        vaultLocator: { namespace: "main", path: "notes/Index.md" },
      });

      const nextVersion = await replaceKnowledgeSource(connected.db, {
        projectId,
        sourceId: target.sourceId,
        displayName: "Target.md",
        content: "# Guide\nUpdated version",
        contentType: "text/markdown",
        sourceKind: "paste",
        permission: "local_only",
      });
      const second = await getActiveKnowledgeMarkdownStructure(
        connected.db,
        projectId,
      );
      expect(second.fingerprint).not.toBe(first.fingerprint);
      expect(
        second.links.find(
          (link) =>
            link.sourceDocumentId === index.sourceId &&
            link.link.rawTarget === "notes/Target#Guide",
        ),
      ).toMatchObject({
        targetDocumentVersionId: nextVersion.versionId,
      });
    }, 30_000);

    it("rejects unsafe Markdown vault locators before saving a source", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);
      for (const path of [
        "../../outside.md",
        "/absolute/note.md",
        "https://example.org/note.md",
        "C:\\vault\\note.md",
      ]) {
        await expect(
          createKnowledgeSource(connected.db, {
            projectId,
            displayName: "unsafe.md",
            content: "Text",
            contentType: "text/markdown",
            sourceKind: "paste",
            permission: "local_only",
            vaultLocator: { path },
          }),
        ).rejects.toMatchObject({ code: "SOURCE_LOCATOR_INVALID" });
      }

      const note = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "note.md",
        content: "Markdown text",
        contentType: "text/markdown",
        sourceKind: "paste",
        permission: "local_only",
        vaultLocator: { path: "notes/note.md" },
      });
      await replaceKnowledgeSource(connected.db, {
        projectId,
        sourceId: note.sourceId,
        displayName: "note.txt",
        content: "Plain text",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "local_only",
      });
      const changedType = await getKnowledgeSource(
        connected.db,
        projectId,
        note.sourceId,
      );
      expect(changedType.sourceMetadata).not.toHaveProperty("vaultLocator");
    });
  },
);

function requireClient(client: DatabaseClient | undefined): DatabaseClient {
  if (!client) throw new Error("Database integration setup did not run.");
  return client;
}

async function createProject(client: DatabaseClient): Promise<string> {
  const unique = randomUUID();
  const [project] = await client.db
    .insert(schema.projects)
    .values({
      ownerId: `knowledge-lifecycle-${unique}`,
      name: `knowledge-lifecycle-${unique}`,
    })
    .returning({ id: schema.projects.id });
  if (!project) throw new Error("Knowledge lifecycle project insert failed.");
  projectIds.push(project.id);
  return project.id;
}

async function createGraphFixture(
  client: DatabaseClient,
  projectId: string,
): Promise<{
  assertionId: string;
  sourceId: string;
  snapshotId: string;
  sourceManifest: Array<Record<string, unknown>>;
  quote: string;
}> {
  const quote = "Service Checkout uses Queue Order.";
  const source = await createKnowledgeSource(client.db, {
    projectId,
    displayName: "Knowledge lifecycle source",
    content: quote,
    contentType: "text/plain",
    sourceKind: "paste",
    permission: "campus_indexer_allowed",
  });
  const preview = await previewGraphBuild(
    client.db,
    projectId,
    { sourceIds: [source.sourceId], requestedModel: null },
    { keyConfigured: false, environmentModel: null },
  );
  const [chunk] = await client.db
    .select({ id: schema.chunks.id })
    .from(schema.chunks)
    .where(eq(schema.chunks.documentVersionId, source.versionId))
    .limit(1);
  if (!chunk) throw new Error("Knowledge lifecycle chunk insert failed.");

  const [build] = await client.db
    .insert(schema.graphBuilds)
    .values({
      projectId,
      sourceManifest: preview.sourceManifest,
      sourceManifestHash: preview.sourceManifestHash,
      extractionPromptVersion: "knowledge-lifecycle-test-v1",
      extractionSchemaVersion: "knowledge-lifecycle-test-v1",
      state: "completed",
    })
    .returning({ id: schema.graphBuilds.id });
  if (!build) throw new Error("Knowledge lifecycle build insert failed.");
  const [snapshot] = await client.db
    .insert(schema.graphSnapshots)
    .values({
      projectId,
      buildId: build.id,
      sourceManifest: preview.sourceManifest,
      sourceManifestHash: preview.sourceManifestHash,
      coverage: {},
      state: "active",
      activatedAt: new Date(),
    })
    .returning({ id: schema.graphSnapshots.id });
  if (!snapshot) throw new Error("Knowledge lifecycle snapshot insert failed.");

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
  if (!subject || !object)
    throw new Error("Knowledge lifecycle entity insert failed.");

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
  if (!assertion)
    throw new Error("Knowledge lifecycle assertion insert failed.");
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
  if (!assertionVersion) {
    throw new Error("Knowledge lifecycle assertion version insert failed.");
  }

  await client.db.insert(schema.graphEvidence).values({
    projectId,
    assertionId: assertion.id,
    assertionVersionId: assertionVersion.id,
    documentVersionId: source.versionId,
    chunkId: chunk.id,
    quote,
    spanStart: 0,
    spanEnd: quote.length,
    sourceChecksum: source.checksum,
  });
  await client.db.insert(schema.graphSnapshotAssertions).values({
    projectId,
    snapshotId: snapshot.id,
    assertionId: assertion.id,
    assertionVersionId: assertionVersion.id,
    sourceManifestHash: preview.sourceManifestHash,
  });
  await client.db.insert(schema.graphActiveSnapshots).values({
    projectId,
    snapshotId: snapshot.id,
  });

  return {
    assertionId: assertion.id,
    sourceId: source.sourceId,
    snapshotId: snapshot.id,
    sourceManifest: preview.sourceManifest,
    quote,
  };
}
