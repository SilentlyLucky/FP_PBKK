import { describe, expect, it, vi } from "vitest";

import type { WorkspaceSourceManifest } from "@promptlab/contracts";
import type { Database } from "@promptlab/db";
import { ProviderRequestError } from "@promptlab/providers";

import {
  createWorkspaceQueryEmbedding,
  executeKnowledgeEmbeddingJob,
  knowledgeEmbeddingJobFromOutbox,
  type KnowledgeEmbeddingAdapter,
  type KnowledgeEmbeddingRuntimeDependencies,
} from "./knowledge-embedding-runtime.ts";

const projectId = "0ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const sourceId = "1ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const versionId = "2ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const vector = Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
const job = { projectId, sourceId, documentVersionId: versionId };
const sourceManifest: WorkspaceSourceManifest = {
  format: "promptlab-workspace-source-manifest-v1",
  sources: [
    {
      documentId: sourceId,
      documentVersionId: versionId,
      documentVersion: 1,
      checksum: "a".repeat(64),
      sourcePermission: "campus_indexer_allowed",
    },
  ],
};

function embeddingResult(model = "embeddinggemma:stable") {
  return {
    requestedModel: "embeddinggemma:latest",
    responseModel: model,
    dimensions: 768,
    vector,
  } as const;
}

function dependencies(
  overrides: Partial<KnowledgeEmbeddingRuntimeDependencies> = {},
): KnowledgeEmbeddingRuntimeDependencies {
  return {
    listChunks: vi.fn(async () => []),
    upsertEmbedding: vi.fn(async () => ({
      id: "embedding-record",
      projectId,
      documentVersionId: versionId,
      chunkId: "chunk-1",
      profileId: "profile-1",
      profileChecksum: "b".repeat(64),
      chunkChecksum: "c".repeat(64),
      vector,
    })),
    getReadiness: vi.fn(async () => []),
    isSourceManifestCurrent: vi.fn(async () => true),
    ...overrides,
  } as unknown as KnowledgeEmbeddingRuntimeDependencies;
}

const db = {} as Database;

describe("knowledge embedding runtime", () => {
  it("accepts only a valid embedding outbox event", () => {
    expect(
      knowledgeEmbeddingJobFromOutbox("knowledge.embedding.enqueue", job),
    ).toEqual(job);
    expect(knowledgeEmbeddingJobFromOutbox("run.enqueue", job)).toBeNull();
    expect(
      knowledgeEmbeddingJobFromOutbox("knowledge.embedding.enqueue", {
        ...job,
        sourceId: "not-an-id",
      }),
    ).toBeNull();
  });

  it("records endpoint absence without reading chunks or calling a provider", async () => {
    const deps = dependencies();
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => embeddingResult()),
    };

    const outcome = await executeKnowledgeEmbeddingJob({
      db,
      job,
      adapter: null,
      requestedModel: null,
      unavailableReason: "embedding_endpoint_not_configured",
      dependencies: deps,
    });

    expect(outcome).toMatchObject({
      status: "not_checked",
      reason: "embedding_endpoint_not_configured",
      profile: null,
    });
    expect(deps.listChunks).not.toHaveBeenCalled();
    expect(adapter.embed).not.toHaveBeenCalled();
  });

  it("does not send source text when the selected version is no longer eligible", async () => {
    const deps = dependencies({
      listChunks: vi.fn(async () => []),
    });
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => embeddingResult()),
    };

    const outcome = await executeKnowledgeEmbeddingJob({
      db,
      job,
      adapter,
      requestedModel: "embeddinggemma:latest",
      dependencies: deps,
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "source_version_not_current_or_permission_denied",
    });
    expect(adapter.embed).not.toHaveBeenCalled();
  });

  it("rechecks the active source version and permission immediately before each egress", async () => {
    const chunk = {
      chunkId: "chunk-1",
      chunkChecksum: "c".repeat(64),
      content: "private selected source text",
    };
    const deps = dependencies({
      listChunks: vi
        .fn(async () => [chunk])
        .mockResolvedValueOnce([chunk])
        .mockResolvedValueOnce([]),
    });
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => embeddingResult()),
    };

    const outcome = await executeKnowledgeEmbeddingJob({
      db,
      job,
      adapter,
      requestedModel: "embeddinggemma:latest",
      dependencies: deps,
    });

    expect(outcome.reason).toBe(
      "source_version_not_current_or_permission_denied",
    );
    expect(deps.listChunks).toHaveBeenCalledTimes(2);
    expect(adapter.embed).not.toHaveBeenCalled();
    expect(deps.upsertEmbedding).not.toHaveBeenCalled();
  });

  it("indexes only current chunks and reports profile-bound readiness", async () => {
    const chunks = [
      {
        chunkId: "chunk-1",
        chunkChecksum: "c".repeat(64),
        content: "first selected source chunk",
      },
      {
        chunkId: "chunk-2",
        chunkChecksum: "d".repeat(64),
        content: "second selected source chunk",
      },
    ];
    const deps = dependencies({
      listChunks: vi.fn(async () => chunks),
      getReadiness: vi.fn(async () => [
        {
          sourceId,
          documentVersionId: versionId,
          chunkCount: 2,
          embeddedChunkCount: 2,
          status: "ready" as const,
        },
      ]),
    });
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => embeddingResult()),
    };

    const outcome = await executeKnowledgeEmbeddingJob({
      db,
      job,
      adapter,
      requestedModel: "embeddinggemma:latest",
      dependencies: deps,
    });

    expect(adapter.embed).toHaveBeenNthCalledWith(1, chunks[0]!.content);
    expect(adapter.embed).toHaveBeenNthCalledWith(2, chunks[1]!.content);
    expect(deps.upsertEmbedding).toHaveBeenCalledTimes(2);
    expect(deps.upsertEmbedding).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        projectId,
        documentVersionId: versionId,
        chunkId: "chunk-1",
        chunkChecksum: chunks[0]!.chunkChecksum,
        profile: expect.objectContaining({
          provider: "campus",
          requestedModel: "embeddinggemma:latest",
          observedModel: "embeddinggemma:stable",
          dimensions: 768,
          chunkingVersion: "knowledge-chunks-v1",
          queryTemplateVersion: "raw-text-v1",
          documentTemplateVersion: "raw-text-v1",
        }),
      }),
    );
    expect(outcome).toMatchObject({
      status: "ready",
      chunkCount: 2,
      embeddedChunkCount: 2,
      reason: null,
      profile: { observedModel: "embeddinggemma:stable" },
    });
  });

  it("records provider failures instead of reporting an index as ready", async () => {
    const chunk = {
      chunkId: "chunk-1",
      chunkChecksum: "c".repeat(64),
      content: "selected source text",
    };
    const deps = dependencies({
      listChunks: vi.fn(async () => [chunk]),
    });
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => {
        throw new ProviderRequestError(
          "AUTH_REQUIRED",
          "redacted provider error",
        );
      }),
    };

    const outcome = await executeKnowledgeEmbeddingJob({
      db,
      job,
      adapter,
      requestedModel: "embeddinggemma:latest",
      dependencies: deps,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "campus_embedding_auth_required",
    });
    expect(deps.upsertEmbedding).not.toHaveBeenCalled();
  });

  it("marks transient provider failures for queue retry", async () => {
    const chunk = {
      chunkId: "chunk-1",
      chunkChecksum: "c".repeat(64),
      content: "selected source text",
    };
    const deps = dependencies({
      listChunks: vi.fn(async () => [chunk]),
    });
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => {
        throw new ProviderRequestError(
          "PROVIDER_TIMEOUT",
          "redacted provider error",
          true,
        );
      }),
    };

    const outcome = await executeKnowledgeEmbeddingJob({
      db,
      job,
      adapter,
      requestedModel: "embeddinggemma:latest",
      dependencies: deps,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "campus_embedding_provider_timeout",
      retryable: true,
    });
    expect(deps.upsertEmbedding).not.toHaveBeenCalled();
  });

  it("rejects malformed document vectors before persistence", async () => {
    const chunk = {
      chunkId: "chunk-1",
      chunkChecksum: "c".repeat(64),
      content: "selected source text",
    };
    const deps = dependencies({
      listChunks: vi.fn(async () => [chunk]),
    });
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => ({ ...embeddingResult(), vector: [1] })),
    };

    const outcome = await executeKnowledgeEmbeddingJob({
      db,
      job,
      adapter,
      requestedModel: "embeddinggemma:latest",
      dependencies: deps,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "embedding_response_invalid",
      profile: null,
    });
    expect(deps.upsertEmbedding).not.toHaveBeenCalled();
  });
});

describe("workspace query embeddings", () => {
  it("checks permission and configuration before query egress", async () => {
    const localOnlyManifest = {
      ...sourceManifest,
      sources: [
        { ...sourceManifest.sources[0]!, sourcePermission: "local_only" },
      ],
    } as unknown as WorkspaceSourceManifest;
    const deps = dependencies();
    const beforeEgress = vi.fn(async () => undefined);
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => embeddingResult()),
    };

    const localOnly = await createWorkspaceQueryEmbedding({
      db,
      projectId,
      query: "query text",
      selectedSourceIds: [sourceId],
      sourceManifest: localOnlyManifest,
      adapter,
      requestedModel: "embeddinggemma:latest",
      beforeEgress,
      dependencies: deps,
    });
    const endpointMissing = await createWorkspaceQueryEmbedding({
      db,
      projectId,
      query: "query text",
      selectedSourceIds: [sourceId],
      sourceManifest,
      adapter: null,
      requestedModel: null,
      unavailableReason: "embedding_endpoint_not_configured",
      beforeEgress,
      dependencies: deps,
    });

    expect(localOnly.reason).toBe("source_permission_not_granted");
    expect(endpointMissing.reason).toBe("embedding_endpoint_not_configured");
    expect(beforeEgress).not.toHaveBeenCalled();
    expect(adapter.embed).not.toHaveBeenCalled();
  });

  it("uses the query only after a fresh permission check and a matching ready profile", async () => {
    const deps = dependencies({
      getReadiness: vi.fn(async () => [
        {
          sourceId,
          documentVersionId: versionId,
          chunkCount: 1,
          embeddedChunkCount: 1,
          status: "ready" as const,
        },
      ]),
    });
    const beforeEgress = vi.fn(async () => undefined);
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => embeddingResult()),
    };

    const outcome = await createWorkspaceQueryEmbedding({
      db,
      projectId,
      query: "only the user query",
      selectedSourceIds: [sourceId],
      sourceManifest,
      adapter,
      requestedModel: "embeddinggemma:latest",
      beforeEgress,
      dependencies: deps,
    });

    expect(beforeEgress).toHaveBeenCalledOnce();
    expect(adapter.embed).toHaveBeenCalledOnce();
    expect(adapter.embed).toHaveBeenCalledWith("only the user query");
    expect(outcome.reason).toBeNull();
    expect(outcome.embedding?.profile.observedModel).toBe(
      "embeddinggemma:stable",
    );
    expect(outcome.embedding?.queryVector).toEqual(vector);
  });

  it("falls back explicitly when no selected source has the query profile indexed", async () => {
    const deps = dependencies({
      getReadiness: vi.fn(async () => [
        {
          sourceId,
          documentVersionId: versionId,
          chunkCount: 1,
          embeddedChunkCount: 0,
          status: "not_indexed" as const,
        },
      ]),
    });
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => embeddingResult()),
    };

    const outcome = await createWorkspaceQueryEmbedding({
      db,
      projectId,
      query: "only the user query",
      selectedSourceIds: [sourceId],
      sourceManifest,
      adapter,
      requestedModel: "embeddinggemma:latest",
      beforeEgress: vi.fn(async () => undefined),
      dependencies: deps,
    });

    expect(outcome).toEqual({
      embedding: null,
      reason: "semantic_index_not_ready",
    });
  });

  it("rejects a malformed query vector without using it for retrieval", async () => {
    const deps = dependencies();
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => ({ ...embeddingResult(), vector: [1] })),
    };

    const outcome = await createWorkspaceQueryEmbedding({
      db,
      projectId,
      query: "only the user query",
      selectedSourceIds: [sourceId],
      sourceManifest,
      adapter,
      requestedModel: "embeddinggemma:latest",
      beforeEgress: vi.fn(async () => undefined),
      dependencies: deps,
    });

    expect(outcome).toEqual({
      embedding: null,
      reason: "embedding_response_invalid",
    });
    expect(deps.getReadiness).not.toHaveBeenCalled();
  });
});
