import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  createKnowledgeSource,
  getActiveGraphSnapshot,
  importGraphifyExport,
  retrieveKnowledgeContext,
  schema,
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
  "graph_mentions",
  "graph_assertions",
  "graph_assertion_versions",
  "graph_evidence",
  "graph_snapshot_assertions",
  "graph_active_snapshots",
];

const projectIds: string[] = [];
const chunkContent = "This text contains no exported symbol or relation.";

describe.skipIf(!integrationRequested)("Graphify import integration", () => {
  let client: DatabaseClient | undefined;

  beforeAll(async () => {
    const target = new URL(connectionString!);
    const databaseName = decodeURIComponent(
      target.pathname.replace(/^\/+/, ""),
    );
    if (
      !["127.0.0.1", "localhost"].includes(target.hostname) ||
      !/^\d+$/u.test(target.port) ||
      Number(target.port) < 1 ||
      Number(target.port) > 65_535 ||
      !/^promptlab_knowledge_test_[a-f0-9]{32}$/iu.test(databaseName)
    ) {
      throw new Error(
        "Graphify integration tests require a disposable UUID-named database on a loopback port, configured with PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL.",
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
        `Graphify integration database is missing migrated tables: ${missingTables.join(", ")}.`,
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

  it("keeps inferred links in review and preserves only current eligible memberships on reimport", async () => {
    const connected = requireClient(client);
    const projectId = await createProject(connected);
    const source = await createKnowledgeSource(connected.db, {
      projectId,
      displayName: "Graphify adapter source",
      content: chunkContent,
      contentType: "text/plain",
      sourceKind: "paste",
      permission: "campus_indexer_allowed",
    });
    const [chunk] = await connected.db
      .select({ id: schema.chunks.id })
      .from(schema.chunks)
      .where(
        and(
          eq(schema.chunks.projectId, projectId),
          eq(schema.chunks.documentVersionId, source.versionId),
        ),
      )
      .limit(1);
    if (!chunk) throw new Error("Graphify integration chunk insert failed.");

    const inferredInput = graphifyInput(
      source,
      chunk.id,
      "src/old.ts",
      "INFERRED",
      "same-symbols",
    );
    const inferredImport = await importGraphifyExport(
      connected.db,
      projectId,
      inferredInput,
    );
    expect(inferredImport).toMatchObject({
      eligibleLinkCount: 0,
      needsReviewLinkCount: 1,
    });

    const [inferredMember] = await graphMembers(
      connected,
      projectId,
      inferredImport.snapshotId,
    );
    expect(inferredMember).toMatchObject({
      status: "needs_review",
      eligible: false,
      changedBy: "graphify_import",
    });
    if (!inferredMember)
      throw new Error("Inferred Graphify member is missing.");

    // Model the legacy adapter state so reimport must downgrade it rather than
    // reuse its old extracted_supported status.
    await connected.db
      .update(schema.graphAssertions)
      .set({ status: "extracted_supported" })
      .where(eq(schema.graphAssertions.id, inferredMember.assertionId));
    await connected.db
      .update(schema.graphAssertionVersions)
      .set({ status: "extracted_supported" })
      .where(
        eq(schema.graphAssertionVersions.id, inferredMember.assertionVersionId),
      );
    await connected.db
      .update(schema.graphSnapshotAssertions)
      .set({ eligible: true })
      .where(
        and(
          eq(schema.graphSnapshotAssertions.projectId, projectId),
          eq(
            schema.graphSnapshotAssertions.snapshotId,
            inferredImport.snapshotId,
          ),
          eq(
            schema.graphSnapshotAssertions.assertionId,
            inferredMember.assertionId,
          ),
        ),
      );

    const extractedInput = graphifyInput(
      source,
      chunk.id,
      "src/new.ts",
      "EXTRACTED",
      "same-symbols",
    );
    const extractedImport = await importGraphifyExport(
      connected.db,
      projectId,
      extractedInput,
    );
    const extractedMembers = await graphMembers(
      connected,
      projectId,
      extractedImport.snapshotId,
    );
    expect(extractedMembers).toHaveLength(1);
    expect(extractedMembers[0]).toMatchObject({
      status: "extracted_supported",
      eligible: true,
    });
    expect(extractedMembers[0]?.assertionId).not.toBe(
      inferredMember.assertionId,
    );

    const reimport = await importGraphifyExport(
      connected.db,
      projectId,
      inferredInput,
    );
    const reimportMembers = await graphMembers(
      connected,
      projectId,
      reimport.snapshotId,
    );
    expect(reimportMembers).toHaveLength(2);
    expect(reimportMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assertionId: inferredMember.assertionId,
          version: 2,
          status: "needs_review",
          eligible: false,
        }),
        expect.objectContaining({
          assertionId: extractedMembers[0]?.assertionId,
          status: "extracted_supported",
          eligible: true,
        }),
      ]),
    );
    expect(
      (await getActiveGraphSnapshot(connected.db, projectId))?.revision,
    ).toBe(3);
    const retrieval = await retrieveKnowledgeContext(connected.db, {
      projectId,
      query: chunkContent,
      strategy: "graph",
      sourceIds: [source.sourceId],
    });
    expect(retrieval.packedContext).toContain(
      "Graph retrieval used lexical fallback",
    );
    expect(retrieval.packedContext).not.toContain("Caller same-symbols");
    expect(retrieval.packedContext).not.toContain("Callee same-symbols");
    expect(retrieval.packedContext).toContain(chunkContent);

    const extractedMember = reimportMembers.find(
      (member) => member.assertionId === extractedMembers[0]?.assertionId,
    );
    if (!extractedMember)
      throw new Error("Retained extracted Graphify member is missing.");
    await connected.db
      .update(schema.graphAssertions)
      .set({ status: "rejected" })
      .where(eq(schema.graphAssertions.id, extractedMember.assertionId));
    await connected.db
      .update(schema.graphAssertionVersions)
      .set({ status: "rejected", changedBy: "local_user" })
      .where(
        eq(
          schema.graphAssertionVersions.id,
          extractedMember.assertionVersionId,
        ),
      );
    const rejectedReimport = await importGraphifyExport(
      connected.db,
      projectId,
      extractedInput,
    );
    expect(rejectedReimport).toMatchObject({
      eligibleLinkCount: 0,
      needsReviewLinkCount: 0,
    });
  }, 20_000);

  it("serializes concurrent first imports and merges both source manifests", async () => {
    const connected = requireClient(client);
    const projectId = await createProject(connected);
    const sourceA = await createKnowledgeSource(connected.db, {
      projectId,
      displayName: "Graphify alpha source",
      content: `${chunkContent} alpha`,
      contentType: "text/plain",
      sourceKind: "paste",
      permission: "campus_indexer_allowed",
    });
    const sourceB = await createKnowledgeSource(connected.db, {
      projectId,
      displayName: "Graphify beta source",
      content: `${chunkContent} beta`,
      contentType: "text/plain",
      sourceKind: "paste",
      permission: "campus_indexer_allowed",
    });
    const [chunkA] = await connected.db
      .select({ id: schema.chunks.id })
      .from(schema.chunks)
      .where(eq(schema.chunks.documentVersionId, sourceA.versionId))
      .limit(1);
    const [chunkB] = await connected.db
      .select({ id: schema.chunks.id })
      .from(schema.chunks)
      .where(eq(schema.chunks.documentVersionId, sourceB.versionId))
      .limit(1);
    if (!chunkA || !chunkB)
      throw new Error("Graphify concurrency chunks were not created.");

    await Promise.all([
      importGraphifyExport(
        connected.db,
        projectId,
        graphifyInput(sourceA, chunkA.id, "src/alpha.ts", "EXTRACTED", "alpha"),
      ),
      importGraphifyExport(
        connected.db,
        projectId,
        graphifyInput(sourceB, chunkB.id, "src/beta.ts", "EXTRACTED", "beta"),
      ),
    ]);

    const active = await getActiveGraphSnapshot(connected.db, projectId);
    expect(active?.revision).toBe(2);
    expect(active?.sourceManifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentVersionId: sourceA.versionId }),
        expect.objectContaining({ documentVersionId: sourceB.versionId }),
      ]),
    );
  }, 20_000);
});

function requireClient(client: DatabaseClient | undefined): DatabaseClient {
  if (!client) throw new Error("Graphify integration setup did not run.");
  return client;
}

async function createProject(client: DatabaseClient): Promise<string> {
  const unique = randomUUID();
  const [project] = await client.db
    .insert(schema.projects)
    .values({
      ownerId: `graphify-integration-${unique}`,
      name: `graphify-integration-${unique}`,
    })
    .returning({ id: schema.projects.id });
  if (!project) throw new Error("Graphify integration project insert failed.");
  projectIds.push(project.id);
  return project.id;
}

function graphifyInput(
  source: { sourceId: string; versionId: string; checksum: string },
  chunkId: string,
  sourceFile: string,
  confidence: "EXTRACTED" | "INFERRED",
  nodeSuffix: string,
) {
  const firstNodeId = `caller-${nodeSuffix}`;
  const secondNodeId = `callee-${nodeSuffix}`;
  return {
    graph: {
      directed: true,
      multigraph: false,
      graph: {},
      nodes: [
        {
          id: firstNodeId,
          label: `Caller ${nodeSuffix}`,
          file_type: "code",
          source_file: sourceFile,
          source_location: "L9999",
        },
        {
          id: secondNodeId,
          label: `Callee ${nodeSuffix}`,
          file_type: "code",
          source_file: sourceFile,
          source_location: "L9998",
        },
      ],
      links: [
        {
          source: firstNodeId,
          target: secondNodeId,
          relation: "calls",
          source_file: sourceFile,
          source_location: "L9997",
          confidence,
          confidence_score: confidence === "EXTRACTED" ? 1 : 0.55,
        },
      ],
    },
    selectedSources: [
      {
        documentId: source.sourceId,
        documentVersionId: source.versionId,
        checksum: source.checksum,
      },
    ],
    nodeBindings: [
      {
        nodeId: firstNodeId,
        sourceFile,
        documentId: source.sourceId,
        documentVersionId: source.versionId,
        checksum: source.checksum,
        chunkId,
        spanStart: 0,
        spanEnd: 4,
      },
      {
        nodeId: secondNodeId,
        sourceFile,
        documentId: source.sourceId,
        documentVersionId: source.versionId,
        checksum: source.checksum,
        chunkId,
        spanStart: 5,
        spanEnd: 9,
      },
    ],
    linkBindings: [
      {
        linkIndex: 0,
        sourceFile,
        documentId: source.sourceId,
        documentVersionId: source.versionId,
        checksum: source.checksum,
        chunkId,
        spanStart: 0,
        spanEnd: 4,
      },
    ],
  };
}

async function graphMembers(
  client: DatabaseClient,
  projectId: string,
  snapshotId: string,
) {
  return client.db
    .select({
      assertionId: schema.graphSnapshotAssertions.assertionId,
      assertionVersionId: schema.graphSnapshotAssertions.assertionVersionId,
      eligible: schema.graphSnapshotAssertions.eligible,
      version: schema.graphAssertionVersions.version,
      status: schema.graphAssertionVersions.status,
      changedBy: schema.graphAssertionVersions.changedBy,
    })
    .from(schema.graphSnapshotAssertions)
    .innerJoin(
      schema.graphAssertionVersions,
      and(
        eq(
          schema.graphAssertionVersions.projectId,
          schema.graphSnapshotAssertions.projectId,
        ),
        eq(
          schema.graphAssertionVersions.assertionId,
          schema.graphSnapshotAssertions.assertionId,
        ),
        eq(
          schema.graphAssertionVersions.id,
          schema.graphSnapshotAssertions.assertionVersionId,
        ),
      ),
    )
    .where(
      and(
        eq(schema.graphSnapshotAssertions.projectId, projectId),
        eq(schema.graphSnapshotAssertions.snapshotId, snapshotId),
      ),
    );
}
