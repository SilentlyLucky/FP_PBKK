import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getKnowledgeEmbeddingReadiness,
  isWorkspaceSourceManifestCurrent,
  retrieveKnowledgeContext,
  type Database,
  type RetrievalResult,
} from "@promptlab/db";

import {
  ensureWorkspaceTargetSourceRetrieval,
  resolveWorkspaceTargetRetrievalSourceIds,
  retrieveWorkspaceTargetSourceContext,
  workspaceTargetRetrievalSatisfiesTargetPreparation,
} from "./workspace-target-retrieval.ts";
import { createWorkspaceTargetEvidencePack } from "./workspace-graph-context.ts";
import type { KnowledgeEmbeddingAdapter } from "./knowledge-embedding-runtime.ts";

vi.mock("@promptlab/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@promptlab/db")>();
  return {
    ...original,
    getKnowledgeEmbeddingReadiness: vi.fn(),
    isWorkspaceSourceManifestCurrent: vi.fn(),
    retrieveKnowledgeContext: vi.fn(),
  };
});

const projectId = "0ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const sourceId = "1ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const versionId = "2ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const checksum = "a".repeat(64);
const traceId = "3ab1d010-a1bb-4dc8-a520-12b6270fb8b3";
const manifest = {
  format: "promptlab-workspace-source-manifest-v1" as const,
  sources: [
    {
      documentId: sourceId,
      documentVersionId: versionId,
      documentVersion: 1,
      checksum,
      sourcePermission: "campus_indexer_allowed" as const,
    },
  ],
};

function retrieval(evidenceCount: number): RetrievalResult {
  return {
    projectId,
    requestedStrategy: "lexical",
    strategyUsed: "lexical",
    snapshotId: null,
    traceId,
    seeds: [],
    paths: [],
    evidence: Array.from({ length: evidenceCount }, (_, index) => ({
      id: `${traceId}-${index}`,
      kind: "chunk" as const,
      quote: "selected source quote",
      documentId: sourceId,
      documentName: "selected.txt",
      sourceRef: null,
      sourceMetadata: {},
      documentVersionId: versionId,
      documentVersion: 1,
      chunkId: `${traceId}-chunk-${index}`,
      pageNumber: null,
      chunkContent: "selected source quote",
      sourceChecksum: checksum,
    })),
    packedContext: evidenceCount ? "selected source quote" : "no match",
    estimatedContextTokens: evidenceCount ? 16 : 0,
    fallbackReason: null,
    clipping: {},
    elapsedMs: 1,
  };
}

describe("retrieveWorkspaceTargetSourceContext", () => {
  beforeEach(() => {
    vi.mocked(isWorkspaceSourceManifestCurrent).mockResolvedValue(true);
    vi.mocked(getKnowledgeEmbeddingReadiness).mockReset();
    vi.mocked(retrieveKnowledgeContext).mockReset();
  });

  it("retries explicit lexical no-match with task terms and the unchanged task", async () => {
    const originalTask =
      "Return a strict response about this selected source as JSON.";
    vi.mocked(retrieveKnowledgeContext)
      .mockResolvedValueOnce(retrieval(0))
      .mockResolvedValueOnce(retrieval(1));

    const attempts = await retrieveWorkspaceTargetSourceContext({
      db: {} as Database,
      projectId,
      sourceIds: [sourceId],
      sourceManifest: manifest,
      requestedStrategy: "lexical",
      originalTask,
      maxEstimatedContextTokens: 3_000,
    });

    const requests = vi
      .mocked(retrieveKnowledgeContext)
      .mock.calls.map(([, request]) => request);
    expect(
      attempts.map((attempt) => attempt.retrieval.evidence.length),
    ).toEqual([0, 1]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.query === originalTask)).toBe(
      true,
    );
    expect(requests.every((request) => request.strategy === "lexical")).toBe(
      true,
    );
    expect(
      requests.every((request) => request.sourceIds?.join() === sourceId),
    ).toBe(true);
    expect(requests[0]?.lexicalQueryMode).toBeUndefined();
    expect(requests[1]?.lexicalQueryMode).toBe("task_terms");
    expect(attempts[1]?.fallbackReason).toBe(
      "lexical_all_prompt_terms_no_match_task_terms_retry",
    );
  });

  it("does not repeat retrieval for Auto, a successful lexical result, or empty selection", async () => {
    vi.mocked(retrieveKnowledgeContext).mockResolvedValue(retrieval(0));
    const base = {
      db: {} as Database,
      projectId,
      sourceIds: [sourceId],
      sourceManifest: manifest,
      originalTask: "Find a fact from the selected source.",
      maxEstimatedContextTokens: 3_000,
    };

    await retrieveWorkspaceTargetSourceContext({
      ...base,
      requestedStrategy: "auto",
    });
    expect(vi.mocked(retrieveKnowledgeContext)).toHaveBeenCalledTimes(1);

    vi.mocked(retrieveKnowledgeContext).mockReset();
    vi.mocked(retrieveKnowledgeContext).mockResolvedValue(retrieval(1));
    await retrieveWorkspaceTargetSourceContext({
      ...base,
      requestedStrategy: "lexical",
    });
    expect(vi.mocked(retrieveKnowledgeContext)).toHaveBeenCalledTimes(1);

    vi.mocked(retrieveKnowledgeContext).mockReset();
    await expect(
      retrieveWorkspaceTargetSourceContext({
        ...base,
        sourceIds: [],
        sourceManifest: { ...manifest, sources: [] },
        requestedStrategy: "lexical",
      }),
    ).resolves.toEqual([]);
    expect(vi.mocked(retrieveKnowledgeContext)).not.toHaveBeenCalled();
  });

  it("rechecks source freshness after each retrieval before returning evidence", async () => {
    vi.mocked(isWorkspaceSourceManifestCurrent)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.mocked(retrieveKnowledgeContext).mockResolvedValue(retrieval(1));

    await expect(
      retrieveWorkspaceTargetSourceContext({
        db: {} as Database,
        projectId,
        sourceIds: [sourceId],
        sourceManifest: manifest,
        requestedStrategy: "lexical",
        originalTask: "Read the selected source.",
        maxEstimatedContextTokens: 3_000,
      }),
    ).rejects.toThrow("WORKSPACE_SOURCE_MANIFEST_CHANGED");
    expect(vi.mocked(retrieveKnowledgeContext)).toHaveBeenCalledTimes(1);
  });

  it("keeps hybrid requested and records endpoint fallback in the evidence pack", async () => {
    vi.mocked(retrieveKnowledgeContext).mockResolvedValue({
      ...retrieval(1),
      requestedStrategy: "hybrid",
      strategyUsed: "lexical",
      fallbackReason: "hybrid_embedding_input_missing",
    });

    const attempts = await retrieveWorkspaceTargetSourceContext({
      db: {} as Database,
      projectId,
      sourceIds: [sourceId],
      sourceManifest: manifest,
      requestedStrategy: "hybrid",
      originalTask: "Find the selected source evidence.",
      maxEstimatedContextTokens: 3_000,
      embeddingAdapter: null,
      embeddingRequestedModel: null,
      embeddingUnavailableReason: "embedding_endpoint_not_configured",
    });

    const request = vi.mocked(retrieveKnowledgeContext).mock.calls[0]?.[1];
    expect(request?.strategy).toBe("hybrid");
    expect(request?.embedding).toBeUndefined();
    expect(attempts[0]?.retrieval.strategyUsed).toBe("lexical");
    expect(attempts[0]?.fallbackReason).toBe(
      "embedding_endpoint_not_configured",
    );
    const pack = createWorkspaceTargetEvidencePack(
      attempts[0]!.retrieval,
      "hybrid",
      attempts[0]!.fallbackReason,
    );
    expect(pack).toMatchObject({
      requestedStrategy: "hybrid",
      strategyUsed: "lexical",
      fallbackReason: "embedding_endpoint_not_configured",
    });
  });

  it("passes a permission-checked query vector to hybrid retrieval", async () => {
    const queryVector = Array.from({ length: 768 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const adapter: KnowledgeEmbeddingAdapter = {
      embed: vi.fn(async () => ({
        requestedModel: "embeddinggemma:latest",
        responseModel: "embeddinggemma:stable",
        dimensions: 768,
        vector: queryVector,
      })),
    };
    vi.mocked(getKnowledgeEmbeddingReadiness).mockResolvedValue([
      {
        sourceId,
        documentVersionId: versionId,
        chunkCount: 1,
        embeddedChunkCount: 1,
        status: "ready" as const,
      },
    ]);
    vi.mocked(retrieveKnowledgeContext).mockResolvedValue({
      ...retrieval(1),
      requestedStrategy: "hybrid",
      strategyUsed: "hybrid",
    });

    const attempts = await retrieveWorkspaceTargetSourceContext({
      db: {} as Database,
      projectId,
      sourceIds: [sourceId],
      sourceManifest: manifest,
      requestedStrategy: "hybrid",
      originalTask: "Find the selected source evidence.",
      maxEstimatedContextTokens: 3_000,
      embeddingAdapter: adapter,
      embeddingRequestedModel: "embeddinggemma:latest",
    });

    const request = vi.mocked(retrieveKnowledgeContext).mock.calls[0]?.[1];
    expect(adapter.embed).toHaveBeenCalledWith(
      "Find the selected source evidence.",
    );
    expect(request).toMatchObject({
      strategy: "hybrid",
      sourceIds: [sourceId],
      embedding: {
        queryVector,
        profile: {
          provider: "campus",
          requestedModel: "embeddinggemma:latest",
          observedModel: "embeddinggemma:stable",
          dimensions: 768,
        },
      },
    });
    expect(attempts[0]?.retrieval.strategyUsed).toBe("hybrid");
  });

  it("requires an original-task miss to be searched before target preparation is complete", () => {
    const selectedSourceIds = [sourceId];
    const base = {
      requestedStrategy: "lexical" as const,
      originalTask: "Answer using the selected source and return JSON.",
      selectedSourceIds,
      retrievedSourceIds: selectedSourceIds,
    };

    expect(
      workspaceTargetRetrievalSatisfiesTargetPreparation({
        ...base,
        retrievalQuery: "Return a strict JSON object.",
        evidenceCount: 0,
      }),
    ).toBe(false);
    expect(
      workspaceTargetRetrievalSatisfiesTargetPreparation({
        ...base,
        retrievalQuery: base.originalTask,
        evidenceCount: 0,
      }),
    ).toBe(true);
    expect(
      workspaceTargetRetrievalSatisfiesTargetPreparation({
        ...base,
        retrievalQuery: "Return a strict JSON object.",
        evidenceCount: 1,
      }),
    ).toBe(true);
    expect(
      workspaceTargetRetrievalSatisfiesTargetPreparation({
        ...base,
        retrievedSourceIds: [],
        retrievalQuery: base.originalTask,
        evidenceCount: 0,
      }),
    ).toBe(false);
    expect(
      workspaceTargetRetrievalSatisfiesTargetPreparation({
        ...base,
        requestedStrategy: "full_context",
        retrievalQuery: "Any query is equivalent for full context.",
        evidenceCount: 0,
      }),
    ).toBe(true);
  });

  it("uses only the frozen selected IDs when a planner search omits its source IDs", () => {
    expect(resolveWorkspaceTargetRetrievalSourceIds([], [sourceId])).toEqual([
      sourceId,
    ]);
    expect(resolveWorkspaceTargetRetrievalSourceIds([], [])).toEqual([]);
    expect(
      resolveWorkspaceTargetRetrievalSourceIds([sourceId], [versionId]),
    ).toEqual([sourceId]);
  });

  it("does not repeat useful or original-task retrieval before the target", async () => {
    const searchKnowledge = vi.fn();
    const context = {} as never;
    const base = {
      requestedStrategy: "lexical" as const,
      originalTask: "Use the selected source.",
      selectedSourceIds: [sourceId],
      retrievedSourceIds: [sourceId],
    };

    for (const retrievalCompleted of [
      workspaceTargetRetrievalSatisfiesTargetPreparation({
        ...base,
        retrievalQuery: "An alternate query.",
        evidenceCount: 1,
      }),
      workspaceTargetRetrievalSatisfiesTargetPreparation({
        ...base,
        retrievalQuery: base.originalTask,
        evidenceCount: 0,
      }),
    ]) {
      await ensureWorkspaceTargetSourceRetrieval({
        requestedStrategy: "lexical",
        sourceIds: [sourceId],
        retrievalCompleted,
        originalTask: base.originalTask,
        handlers: { search_knowledge: searchKnowledge },
        context,
      });
    }

    expect(searchKnowledge).not.toHaveBeenCalled();
  });

  it("keeps explicit Graph retrieval strict when Graph is unavailable", async () => {
    const searchKnowledge = vi.fn();
    const searchGraph = vi.fn().mockResolvedValue({
      available: false,
      reason: "snapshot_unavailable",
    });

    await expect(
      ensureWorkspaceTargetSourceRetrieval({
        requestedStrategy: "graph",
        sourceIds: [sourceId],
        retrievalCompleted: false,
        originalTask: "Use the selected source.",
        handlers: {
          search_knowledge: searchKnowledge,
          search_graph_entities: searchGraph,
        },
        context: {} as never,
      }),
    ).rejects.toThrow("WORKSPACE_CHAT_GRAPH_RETRIEVAL_UNAVAILABLE");

    expect(searchGraph).toHaveBeenCalledTimes(1);
    expect(searchKnowledge).not.toHaveBeenCalled();
  });
});
