import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  createKnowledgeSource,
  deleteKnowledgeSource,
  getKnowledgeEmbeddingIndexReadiness,
  getKnowledgeEmbeddingReadiness,
  listKnowledgeChunksForEmbedding,
  replaceKnowledgeSource,
  retrieveKnowledgeContext,
  searchKnowledgeEmbeddings,
  schema,
  setKnowledgeSourcePermission,
  upsertKnowledgeChunkEmbedding,
  type DatabaseClient,
  type KnowledgeEmbeddingProfileInput,
} from "./index.ts";

const connectionString = process.env.PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL;
const integrationRequested =
  process.env.PROMPTLAB_KNOWLEDGE_LIFECYCLE_INTEGRATION_TESTS === "1" &&
  Boolean(connectionString);

const requiredTables = [
  "projects",
  "documents",
  "document_versions",
  "chunks",
  "knowledge_embedding_profiles",
  "knowledge_chunk_embeddings",
  "outbox",
];

const projectIds: string[] = [];
const profile: KnowledgeEmbeddingProfileInput = {
  provider: "fixture",
  requestedModel: "embedding-test-v1",
  observedModel: "embedding-test-v1",
  modelDigest: null,
  dimensions: 768,
  chunkingVersion: "structure-chunks-v1",
  preprocessingVersion: "plain-v1",
  queryTemplateVersion: "query-v1",
  documentTemplateVersion: "document-v1",
};

describe.skipIf(!integrationRequested)(
  "Knowledge embedding integration",
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
          "Knowledge embedding integration tests require a disposable UUID-named database on loopback port 56432, configured with PROMPTLAB_KNOWLEDGE_TEST_DATABASE_URL.",
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
          `Knowledge embedding integration database is missing migrated tables: ${missingTables.join(", ")}.`,
        );
      }
      const extensions = await connected.pool.query<{ extname: string }>(
        `select extname from pg_extension where extname = 'vector'`,
      );
      if (extensions.rowCount !== 1) {
        throw new Error(
          "Knowledge embedding integration database is missing the pgvector extension.",
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

    it("binds idempotent vectors to active versions and filters selected permissions", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);
      const rawByteSha256 = "a".repeat(64);
      const source = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Allowed source",
        content: "Selected source content.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
        rawByteSha256,
        rawByteSize: 24,
      });
      expect(source).toMatchObject({ rawByteSha256, rawByteSize: 24 });
      expect(
        await embeddingEvents(connected, projectId, source.sourceId),
      ).toEqual([
        {
          eventType: "knowledge.embedding.enqueue",
          payload: {
            projectId,
            sourceId: source.sourceId,
            documentVersionId: source.versionId,
          },
        },
      ]);
      const sourceChunk = await getChunk(
        connected,
        projectId,
        source.versionId,
      );
      expect(
        await listKnowledgeChunksForEmbedding(connected.db, {
          projectId,
          sourceId: source.sourceId,
          documentVersionId: source.versionId,
        }),
      ).toEqual([
        {
          chunkId: sourceChunk.id,
          chunkChecksum: sourceChunk.contentHash,
          content: "Selected source content.",
        },
      ]);
      expect(
        await getKnowledgeEmbeddingReadiness(connected.db, {
          projectId,
          selectedSourceIds: [source.sourceId],
          profile,
        }),
      ).toMatchObject([
        {
          sourceId: source.sourceId,
          documentVersionId: source.versionId,
          chunkCount: 1,
          embeddedChunkCount: 0,
          status: "not_indexed",
        },
      ]);
      const sourceVector = unitVector(0);
      const embeddingInput = {
        projectId,
        documentVersionId: source.versionId,
        chunkId: sourceChunk.id,
        chunkChecksum: sourceChunk.contentHash,
        profile,
        vector: sourceVector,
      };
      const first = await upsertKnowledgeChunkEmbedding(
        connected.db,
        embeddingInput,
      );
      const retry = await upsertKnowledgeChunkEmbedding(
        connected.db,
        embeddingInput,
      );
      expect(retry).toEqual(first);
      expect(
        await getKnowledgeEmbeddingReadiness(connected.db, {
          projectId,
          selectedSourceIds: [source.sourceId],
          profile,
        }),
      ).toMatchObject([
        {
          sourceId: source.sourceId,
          documentVersionId: source.versionId,
          chunkCount: 1,
          embeddedChunkCount: 1,
          status: "ready",
        },
      ]);
      expect(
        await getKnowledgeEmbeddingReadiness(connected.db, {
          projectId,
          selectedSourceIds: [source.sourceId],
          profile: { ...profile, documentTemplateVersion: "document-v2" },
        }),
      ).toMatchObject([
        {
          chunkCount: 1,
          embeddedChunkCount: 0,
          status: "not_indexed",
        },
      ]);
      await expect(
        upsertKnowledgeChunkEmbedding(connected.db, {
          ...embeddingInput,
          vector: unitVector(1),
        }),
      ).rejects.toMatchObject({ code: "EMBEDDING_IDEMPOTENCY_CONFLICT" });

      const localSource = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Local only source",
        content: "Local only content.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "local_only",
      });
      expect(
        await embeddingEvents(connected, projectId, localSource.sourceId),
      ).toEqual([]);
      expect(localSource).toMatchObject({
        rawByteSha256: null,
        rawByteSize: null,
      });
      const localChunk = await getChunk(
        connected,
        projectId,
        localSource.versionId,
      );
      // Model a stale or imported index row to prove retrieval itself still
      // applies the source permission check even when rows exist in the table.
      await connected.db.insert(schema.knowledgeChunkEmbeddings).values({
        projectId,
        documentVersionId: localSource.versionId,
        chunkId: localChunk.id,
        profileId: first.profileId,
        profileChecksum: first.profileChecksum,
        chunkChecksum: localChunk.contentHash,
        embedding: unitVector(0),
      });
      const selectedResults = await searchKnowledgeEmbeddings(connected.db, {
        projectId,
        selectedSourceIds: [source.sourceId, localSource.sourceId],
        profile,
        queryVector: unitVector(0),
      });
      expect(selectedResults.map((item) => item.sourceId)).toEqual([
        source.sourceId,
      ]);
      expect(
        await searchKnowledgeEmbeddings(connected.db, {
          projectId,
          selectedSourceIds: [localSource.sourceId],
          profile,
          queryVector: unitVector(0),
        }),
      ).toEqual([]);
      expect(
        await searchKnowledgeEmbeddings(connected.db, {
          projectId,
          selectedSourceIds: [source.sourceId],
          profile: { ...profile, documentTemplateVersion: "document-v2" },
          queryVector: unitVector(0),
        }),
      ).toEqual([]);

      const rawBytesChanged = await replaceKnowledgeSource(connected.db, {
        projectId,
        sourceId: source.sourceId,
        displayName: "Allowed source",
        content: "Selected source content.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
        rawByteSha256: "b".repeat(64),
        rawByteSize: 25,
      });
      expect(rawBytesChanged).toMatchObject({
        version: source.version + 1,
        rawByteSha256: "b".repeat(64),
        rawByteSize: 25,
      });
      expect(
        await embeddingEvents(connected, projectId, source.sourceId),
      ).toHaveLength(2);
      expect(
        await embeddingRowCount(connected, projectId, source.versionId),
      ).toBe(0);
      expect(
        await listKnowledgeChunksForEmbedding(connected.db, {
          projectId,
          sourceId: source.sourceId,
          documentVersionId: source.versionId,
        }),
      ).toEqual([]);
      await connected.db.insert(schema.knowledgeChunkEmbeddings).values({
        projectId,
        documentVersionId: source.versionId,
        chunkId: sourceChunk.id,
        profileId: first.profileId,
        profileChecksum: first.profileChecksum,
        chunkChecksum: sourceChunk.contentHash,
        embedding: sourceVector,
      });
      expect(
        await searchKnowledgeEmbeddings(connected.db, {
          projectId,
          selectedSourceIds: [source.sourceId],
          profile,
          queryVector: unitVector(0),
        }),
      ).toEqual([]);
      await replaceKnowledgeSource(connected.db, {
        projectId,
        sourceId: source.sourceId,
        displayName: "Allowed source",
        content: "Selected source content.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
        rawByteSha256: "b".repeat(64),
        rawByteSize: 25,
      });
      expect(
        await embeddingEvents(connected, projectId, source.sourceId),
      ).toHaveLength(2);
      await expect(
        upsertKnowledgeChunkEmbedding(connected.db, embeddingInput),
      ).rejects.toMatchObject({ code: "SOURCE_NOT_ELIGIBLE" });
      expect(
        await searchKnowledgeEmbeddings(connected.db, {
          projectId,
          selectedSourceIds: [source.sourceId],
          profile,
          queryVector: unitVector(0),
        }),
      ).toEqual([]);

      const permittedCurrentChunk = await getChunk(
        connected,
        projectId,
        rawBytesChanged.versionId,
      );
      await upsertKnowledgeChunkEmbedding(connected.db, {
        projectId,
        documentVersionId: rawBytesChanged.versionId,
        chunkId: permittedCurrentChunk.id,
        chunkChecksum: permittedCurrentChunk.contentHash,
        profile,
        vector: unitVector(0),
      });

      const revoked = await replaceKnowledgeSource(connected.db, {
        projectId,
        sourceId: source.sourceId,
        displayName: "Allowed source",
        content: "Selected source content.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "local_only",
      });
      expect(revoked.versionId).toBe(rawBytesChanged.versionId);
      expect(
        await embeddingRowCount(connected, projectId, revoked.versionId),
      ).toBe(0);
      expect(
        await listKnowledgeChunksForEmbedding(connected.db, {
          projectId,
          sourceId: source.sourceId,
          documentVersionId: revoked.versionId,
        }),
      ).toEqual([]);
      expect(
        await getKnowledgeEmbeddingReadiness(connected.db, {
          projectId,
          selectedSourceIds: [source.sourceId],
          profile,
        }),
      ).toMatchObject([
        {
          sourceId: source.sourceId,
          documentVersionId: null,
          chunkCount: 0,
          embeddedChunkCount: 0,
          status: "blocked",
        },
      ]);
      const revokedChunk = await getChunk(
        connected,
        projectId,
        revoked.versionId,
      );
      await expect(
        upsertKnowledgeChunkEmbedding(connected.db, {
          projectId,
          documentVersionId: revoked.versionId,
          chunkId: revokedChunk.id,
          chunkChecksum: revokedChunk.contentHash,
          profile,
          vector: unitVector(0),
        }),
      ).rejects.toMatchObject({ code: "SOURCE_PERMISSION_REQUIRED" });
      expect(
        await searchKnowledgeEmbeddings(connected.db, {
          projectId,
          selectedSourceIds: [source.sourceId],
          profile,
          queryVector: unitVector(0),
        }),
      ).toEqual([]);

      await setKnowledgeSourcePermission(
        connected.db,
        projectId,
        source.sourceId,
        "campus_indexer_allowed",
      );
      expect(
        await embeddingEvents(connected, projectId, source.sourceId),
      ).toHaveLength(3);
      expect(
        await listKnowledgeChunksForEmbedding(connected.db, {
          projectId,
          sourceId: source.sourceId,
          documentVersionId: revoked.versionId,
        }),
      ).toHaveLength(1);
      const reallowedChunk = await getChunk(
        connected,
        projectId,
        revoked.versionId,
      );
      await upsertKnowledgeChunkEmbedding(connected.db, {
        projectId,
        documentVersionId: revoked.versionId,
        chunkId: reallowedChunk.id,
        chunkChecksum: reallowedChunk.contentHash,
        profile,
        vector: unitVector(0),
      });
      await deleteKnowledgeSource(connected.db, projectId, source.sourceId);
      expect(
        await embeddingRowCount(connected, projectId, revoked.versionId),
      ).toBe(0);
      expect(
        await listKnowledgeChunksForEmbedding(connected.db, {
          projectId,
          sourceId: source.sourceId,
          documentVersionId: revoked.versionId,
        }),
      ).toEqual([]);
    }, 20_000);

    it("retrieves a paraphrase match with hybrid fusion inside selected scope", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);
      const arithmetic = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Arithmetic statement",
        content: "2 + 2 = 5",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      const arithmeticChunk = await getChunk(
        connected,
        projectId,
        arithmetic.versionId,
      );
      const arithmeticVector = unitVector(4);
      const embedding = await upsertKnowledgeChunkEmbedding(connected.db, {
        projectId,
        documentVersionId: arithmetic.versionId,
        chunkId: arithmeticChunk.id,
        chunkChecksum: arithmeticChunk.contentHash,
        profile,
        vector: arithmeticVector,
      });
      const outsideSelection = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Unselected statement",
        content: "2 + 2 = 6",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      const outsideChunk = await getChunk(
        connected,
        projectId,
        outsideSelection.versionId,
      );
      await connected.db.insert(schema.knowledgeChunkEmbeddings).values({
        projectId,
        documentVersionId: outsideSelection.versionId,
        chunkId: outsideChunk.id,
        profileId: embedding.profileId,
        profileChecksum: embedding.profileChecksum,
        chunkChecksum: outsideChunk.contentHash,
        embedding: arithmeticVector,
      });

      const partialSource = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Partial source",
        content: "First portion.\n\nSecond portion.",
        chunks: [{ content: "First portion." }, { content: "Second portion." }],
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      const partialChunks = await listKnowledgeChunksForEmbedding(
        connected.db,
        {
          projectId,
          sourceId: partialSource.sourceId,
          documentVersionId: partialSource.versionId,
        },
      );
      expect(partialChunks).toHaveLength(2);
      await upsertKnowledgeChunkEmbedding(connected.db, {
        projectId,
        documentVersionId: partialSource.versionId,
        chunkId: partialChunks[0]!.chunkId,
        chunkChecksum: partialChunks[0]!.chunkChecksum,
        profile,
        vector: unitVector(5),
      });
      expect(
        await getKnowledgeEmbeddingReadiness(connected.db, {
          projectId,
          selectedSourceIds: [partialSource.sourceId],
          profile,
        }),
      ).toMatchObject([
        {
          sourceId: partialSource.sourceId,
          documentVersionId: partialSource.versionId,
          chunkCount: 2,
          embeddedChunkCount: 1,
          status: "partial",
        },
      ]);

      const result = await retrieveKnowledgeContext(connected.db, {
        projectId,
        query: "What is the result of adding two and two?",
        strategy: "hybrid",
        sourceIds: [arithmetic.sourceId],
        embedding: { profile, queryVector: arithmeticVector },
      });
      expect(result.strategyUsed).toBe("hybrid");
      expect(result.clipping).toMatchObject({
        retrievalMethod: "reciprocal_rank_fusion",
        lexicalHits: 0,
        vectorHits: 1,
        fusedHits: 1,
      });
      expect(result.evidence).toContainEqual(
        expect.objectContaining({
          documentId: arithmetic.sourceId,
          documentVersionId: arithmetic.versionId,
          chunkId: arithmeticChunk.id,
          chunkContent: "2 + 2 = 5",
        }),
      );
      expect(
        result.evidence.some(
          (item) => item.documentId === outsideSelection.sourceId,
        ),
      ).toBe(false);
      await expect(
        retrieveKnowledgeContext(connected.db, {
          projectId,
          query: "What is the result of adding two and two?",
          strategy: "hybrid",
          sourceIds: [arithmetic.sourceId],
          embedding: { profile, queryVector: [1] },
        }),
      ).rejects.toMatchObject({ code: "VECTOR_INVALID" });
      const missingVector = await retrieveKnowledgeContext(connected.db, {
        projectId,
        query: "What is the result of adding two and two?",
        strategy: "hybrid",
        sourceIds: [arithmetic.sourceId],
      });
      expect(missingVector.strategyUsed).toBe("lexical");
      expect(missingVector.fallbackReason).toBe(
        "hybrid_embedding_input_missing",
      );
    }, 20_000);

    it("reports stored semantic coverage by active profile without assuming query compatibility", async () => {
      const connected = requireClient(client);
      const projectId = await createProject(connected);
      const profileV2: KnowledgeEmbeddingProfileInput = {
        ...profile,
        requestedModel: "embedding-test-v2",
        observedModel: "embedding-response-v2",
      };

      const readySource = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Multi-profile source",
        content: "First paragraph.\n\nSecond paragraph.",
        chunks: [
          { content: "First paragraph." },
          { content: "Second paragraph." },
        ],
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      const readyChunks = await listKnowledgeChunksForEmbedding(connected.db, {
        projectId,
        sourceId: readySource.sourceId,
        documentVersionId: readySource.versionId,
      });
      for (const [index, chunk] of readyChunks.entries()) {
        await upsertKnowledgeChunkEmbedding(connected.db, {
          projectId,
          documentVersionId: readySource.versionId,
          chunkId: chunk.chunkId,
          chunkChecksum: chunk.chunkChecksum,
          profile,
          vector: unitVector(index),
        });
      }
      await upsertKnowledgeChunkEmbedding(connected.db, {
        projectId,
        documentVersionId: readySource.versionId,
        chunkId: readyChunks[0]!.chunkId,
        chunkChecksum: readyChunks[0]!.chunkChecksum,
        profile: profileV2,
        vector: unitVector(2),
      });

      const partialSource = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Partial profile source",
        content: "First paragraph.\n\nSecond paragraph.",
        chunks: [
          { content: "First paragraph." },
          { content: "Second paragraph." },
        ],
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      const partialChunks = await listKnowledgeChunksForEmbedding(
        connected.db,
        {
          projectId,
          sourceId: partialSource.sourceId,
          documentVersionId: partialSource.versionId,
        },
      );
      await upsertKnowledgeChunkEmbedding(connected.db, {
        projectId,
        documentVersionId: partialSource.versionId,
        chunkId: partialChunks[0]!.chunkId,
        chunkChecksum: partialChunks[0]!.chunkChecksum,
        profile: profileV2,
        vector: unitVector(3),
      });

      const notIndexedSource = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Not indexed source",
        content: "No semantic vector yet.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      const blockedSource = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Local only source",
        content: "Local-only semantic indexing is blocked.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "local_only",
      });

      const staleSource = await createKnowledgeSource(connected.db, {
        projectId,
        displayName: "Stale source",
        content: "Old version content.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      const staleChunk = await getChunk(
        connected,
        projectId,
        staleSource.versionId,
      );
      const staleEmbedding = await upsertKnowledgeChunkEmbedding(connected.db, {
        projectId,
        documentVersionId: staleSource.versionId,
        chunkId: staleChunk.id,
        chunkChecksum: staleChunk.contentHash,
        profile,
        vector: unitVector(4),
      });
      await replaceKnowledgeSource(connected.db, {
        projectId,
        sourceId: staleSource.sourceId,
        displayName: "Stale source",
        content: "Replacement version content.",
        contentType: "text/plain",
        sourceKind: "paste",
        permission: "campus_indexer_allowed",
      });
      await connected.db.insert(schema.knowledgeChunkEmbeddings).values({
        projectId,
        documentVersionId: staleSource.versionId,
        chunkId: staleChunk.id,
        profileId: staleEmbedding.profileId,
        profileChecksum: staleEmbedding.profileChecksum,
        chunkChecksum: staleChunk.contentHash,
        embedding: unitVector(4),
      });

      const readiness = await getKnowledgeEmbeddingIndexReadiness(
        connected.db,
        {
          projectId,
          selectedSourceIds: [
            readySource.sourceId,
            partialSource.sourceId,
            notIndexedSource.sourceId,
            blockedSource.sourceId,
            staleSource.sourceId,
          ],
        },
      );
      const bySourceId = new Map(
        readiness.map((item) => [item.sourceId, item]),
      );

      expect(bySourceId.get(readySource.sourceId)).toMatchObject({
        status: "ready",
        retrievalProfileCompatibility: "not_verified",
        profiles: expect.arrayContaining([
          expect.objectContaining({
            requestedModel: profile.requestedModel,
            observedModel: profile.observedModel,
            chunkCount: 2,
            embeddedChunkCount: 2,
            status: "ready",
          }),
          expect.objectContaining({
            requestedModel: profileV2.requestedModel,
            observedModel: profileV2.observedModel,
            chunkCount: 2,
            embeddedChunkCount: 1,
            status: "partial",
          }),
        ]),
      });
      expect(bySourceId.get(partialSource.sourceId)).toMatchObject({
        status: "partial",
        profiles: [
          expect.objectContaining({
            requestedModel: profileV2.requestedModel,
            embeddedChunkCount: 1,
            chunkCount: 2,
            status: "partial",
          }),
        ],
      });
      expect(bySourceId.get(notIndexedSource.sourceId)).toMatchObject({
        status: "not_indexed",
        profiles: [],
      });
      expect(bySourceId.get(blockedSource.sourceId)).toMatchObject({
        status: "blocked",
        reason: "source_permission_not_granted",
        profiles: [],
      });
      expect(bySourceId.get(staleSource.sourceId)).toMatchObject({
        status: "stale",
        staleEmbeddingCount: 1,
        profiles: [],
      });
    }, 20_000);
  },
);

async function createProject(connected: DatabaseClient): Promise<string> {
  const [project] = await connected.db
    .insert(schema.projects)
    .values({ name: `Embedding test ${randomUUID()}` })
    .returning({ id: schema.projects.id });
  if (!project) throw new Error("Project insert returned no row");
  projectIds.push(project.id);
  return project.id;
}

async function getChunk(
  connected: DatabaseClient,
  projectId: string,
  documentVersionId: string,
): Promise<{ id: string; contentHash: string }> {
  const [chunk] = await connected.db
    .select({ id: schema.chunks.id, contentHash: schema.chunks.contentHash })
    .from(schema.chunks)
    .where(
      and(
        eq(schema.chunks.projectId, projectId),
        eq(schema.chunks.documentVersionId, documentVersionId),
      ),
    )
    .limit(1);
  if (!chunk) throw new Error("Source insert returned no chunk");
  return chunk;
}

async function embeddingEvents(
  connected: DatabaseClient,
  projectId: string,
  sourceId: string,
): Promise<Array<{ eventType: string; payload: Record<string, unknown> }>> {
  return connected.db
    .select({
      eventType: schema.outbox.eventType,
      payload: schema.outbox.payload,
    })
    .from(schema.outbox)
    .where(
      and(
        eq(schema.outbox.projectId, projectId),
        eq(schema.outbox.aggregateId, sourceId),
        eq(schema.outbox.eventType, "knowledge.embedding.enqueue"),
      ),
    );
}

async function embeddingRowCount(
  connected: DatabaseClient,
  projectId: string,
  documentVersionId: string,
): Promise<number> {
  const rows = await connected.db
    .select({ id: schema.knowledgeChunkEmbeddings.id })
    .from(schema.knowledgeChunkEmbeddings)
    .where(
      and(
        eq(schema.knowledgeChunkEmbeddings.projectId, projectId),
        eq(
          schema.knowledgeChunkEmbeddings.documentVersionId,
          documentVersionId,
        ),
      ),
    );
  return rows.length;
}

function requireClient(client: DatabaseClient | undefined): DatabaseClient {
  if (!client) throw new Error("Integration database client is unavailable");
  return client;
}

function unitVector(index: number): number[] {
  return Array.from({ length: 768 }, (_, item) => (item === index ? 1 : 0));
}
