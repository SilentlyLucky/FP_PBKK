import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  getProjectReadiness: vi.fn(),
  getKnowledgeEmbeddingIndexReadiness: vi.fn(),
  listKnowledgeSources: vi.fn(),
  listGraphBuilds: vi.fn(),
  listActiveGraphAssertions: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    databaseOrUnavailable: () => ({ db: mocks.db }),
  };
});

vi.mock("@promptlab/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@promptlab/db")>();
  return {
    ...actual,
    getProjectReadiness: mocks.getProjectReadiness,
    getKnowledgeEmbeddingIndexReadiness:
      mocks.getKnowledgeEmbeddingIndexReadiness,
    listKnowledgeSources: mocks.listKnowledgeSources,
    listGraphBuilds: mocks.listGraphBuilds,
    listActiveGraphAssertions: mocks.listActiveGraphAssertions,
  };
});

import { GET } from "./route.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const semanticReadiness = {
  sourceId,
  documentVersionId: "33333333-3333-4333-8333-333333333333",
  chunkCount: 1,
  staleEmbeddingCount: 0,
  status: "ready",
  reason: null,
  retrievalProfileCompatibility: "not_verified",
  profiles: [
    {
      profileId: "44444444-4444-4444-8444-444444444444",
      profileChecksum: "a".repeat(64),
      provider: "campus",
      requestedModel: "embedding-requested",
      observedModel: "embedding-observed",
      modelDigest: null,
      dimensions: 768,
      chunkingVersion: "chunks-v1",
      preprocessingVersion: "identity-v1",
      queryTemplateVersion: "query-v1",
      documentTemplateVersion: "document-v1",
      chunkCount: 1,
      embeddedChunkCount: 1,
      status: "ready",
    },
  ],
};

describe("knowledge readiness route", () => {
  beforeEach(() => {
    mocks.db = {};
    mocks.getProjectReadiness.mockReset().mockResolvedValue({
      documents: { total: 1, eligible: 1, chunkCount: 1 },
      snapshot: { id: null, status: "none", buildId: null, revision: null },
      build: { id: null, state: "none" },
      retrieval: {
        status: "lexical",
        backend: "postgres",
        graphAvailable: false,
        fallback: null,
      },
      indexer: {
        requestedModel: null,
        connectionStatus: "unknown",
        ready: false,
        reason: null,
      },
    });
    mocks.getKnowledgeEmbeddingIndexReadiness
      .mockReset()
      .mockResolvedValue([semanticReadiness]);
    mocks.listKnowledgeSources.mockReset().mockResolvedValue([
      {
        id: sourceId,
        displayName: "Notes",
        permission: "campus_indexer_allowed",
      },
    ]);
    mocks.listGraphBuilds.mockReset().mockResolvedValue([]);
    mocks.listActiveGraphAssertions.mockReset().mockResolvedValue({
      snapshotId: null,
      assertions: [],
    });
  });

  it("returns persisted semantic profile coverage alongside each source", async () => {
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId }),
    });

    expect(response.status).toBe(200);
    expect(mocks.getKnowledgeEmbeddingIndexReadiness).toHaveBeenCalledWith(
      mocks.db,
      { projectId, selectedSourceIds: [sourceId] },
    );
    expect(await response.json()).toMatchObject({
      projectId,
      sources: [{ id: sourceId, semanticReadiness }],
    });
  });
});
