import type { WorkspaceSourceManifest } from "@promptlab/contracts";
import {
  isWorkspaceSourceManifestCurrent,
  retrieveKnowledgeContext,
  type Database,
  type RetrievalRequest,
  type RetrievalResult,
} from "@promptlab/db";
import type { ToolContext, ToolHandlers } from "@promptlab/tools";
import {
  createWorkspaceQueryEmbedding,
  type KnowledgeEmbeddingAdapter,
} from "./knowledge-embedding-runtime.ts";

type WorkspaceRetrievalStrategy =
  | "auto"
  | "lexical"
  | "graph"
  | "full_context"
  | "hybrid";

export interface WorkspaceTargetRetrievalAttempt {
  retrieval: RetrievalResult;
  fallbackReason: string | null;
}

export function resolveWorkspaceTargetRetrievalSourceIds(
  requestedSourceIds: readonly string[] | undefined,
  selectedSourceIds: readonly string[],
): string[] {
  return [
    ...(requestedSourceIds?.length ? requestedSourceIds : selectedSourceIds),
  ];
}

export function workspaceTargetRetrievalSatisfiesTargetPreparation(input: {
  requestedStrategy: WorkspaceRetrievalStrategy;
  retrievalQuery: string;
  originalTask: string;
  selectedSourceIds: readonly string[];
  retrievedSourceIds: readonly string[];
  evidenceCount: number;
}): boolean {
  if (!input.selectedSourceIds.length || !input.retrievedSourceIds.length) {
    return false;
  }

  const selectedSourceIds = new Set(input.selectedSourceIds);
  const retrievedSourceIds = new Set(input.retrievedSourceIds);
  if (
    retrievedSourceIds.size !== input.retrievedSourceIds.length ||
    [...retrievedSourceIds].some((sourceId) => !selectedSourceIds.has(sourceId))
  ) {
    return false;
  }

  if (input.evidenceCount > 0) return true;

  const retrievedFullSelection =
    retrievedSourceIds.size === selectedSourceIds.size &&
    [...selectedSourceIds].every((sourceId) =>
      retrievedSourceIds.has(sourceId),
    );
  if (!retrievedFullSelection) return false;

  return (
    input.requestedStrategy === "full_context" ||
    input.retrievalQuery === input.originalTask
  );
}

/**
 * Retrieve from the exact frozen Workspace source selection. Auto uses hybrid
 * lexical and semantic retrieval for the knowledge route. Explicit lexical
 * keeps the all-prompt-terms behavior and, on a miss, retries with meaningful
 * task terms while preserving the original task string and selected-source
 * scope. No-match results remain empty.
 */
export async function retrieveWorkspaceTargetSourceContext(input: {
  db: Database;
  projectId: string;
  sourceIds: readonly string[];
  sourceManifest: WorkspaceSourceManifest;
  requestedStrategy: WorkspaceRetrievalStrategy;
  originalTask: string;
  graphSnapshotId?: string | null;
  runId?: string | null;
  maxEstimatedContextTokens: number;
  embeddingAdapter?: KnowledgeEmbeddingAdapter | null;
  embeddingRequestedModel?: string | null;
  embeddingUnavailableReason?: string | null;
  retrieve?: (
    db: Database,
    request: RetrievalRequest,
  ) => Promise<RetrievalResult>;
}): Promise<WorkspaceTargetRetrievalAttempt[]> {
  if (!input.sourceIds.length) return [];

  const requestedSourceIds = [...input.sourceIds];
  const requestedManifest = input.sourceManifest.sources.filter((source) =>
    requestedSourceIds.includes(source.documentId),
  );
  if (requestedManifest.length !== requestedSourceIds.length) {
    throw new Error("WORKSPACE_SOURCE_MANIFEST_MISSING");
  }

  const assertSourceManifestCurrent = async () => {
    if (
      !(await isWorkspaceSourceManifestCurrent(
        input.db,
        input.projectId,
        input.sourceManifest,
      ))
    ) {
      throw new Error("WORKSPACE_SOURCE_MANIFEST_CHANGED");
    }
  };
  const strategy =
    input.requestedStrategy === "auto" ? "hybrid" : input.requestedStrategy;
  const retrieve = input.retrieve ?? retrieveKnowledgeContext;
  const queryEmbedding =
    strategy === "hybrid"
      ? await createWorkspaceQueryEmbedding({
          db: input.db,
          projectId: input.projectId,
          query: input.originalTask,
          selectedSourceIds: requestedSourceIds,
          sourceManifest: input.sourceManifest,
          adapter: input.embeddingAdapter ?? null,
          requestedModel: input.embeddingRequestedModel ?? null,
          ...(input.embeddingUnavailableReason === undefined
            ? {}
            : { unavailableReason: input.embeddingUnavailableReason }),
          beforeEgress: assertSourceManifestCurrent,
        })
      : null;
  const runRetrieval = async (
    lexicalQueryMode?: RetrievalRequest["lexicalQueryMode"],
  ) => {
    await assertSourceManifestCurrent();
    const request: RetrievalRequest = {
      projectId: input.projectId,
      query: input.originalTask,
      strategy,
      sourceIds: requestedSourceIds,
      sourceManifest: requestedManifest,
      snapshotId: strategy === "graph" ? (input.graphSnapshotId ?? null) : null,
      bounds: {
        maxEstimatedContextTokens: input.maxEstimatedContextTokens,
      },
      ...(input.runId ? { runId: input.runId } : {}),
      ...(lexicalQueryMode ? { lexicalQueryMode } : {}),
      ...(queryEmbedding?.embedding
        ? { embedding: queryEmbedding.embedding }
        : {}),
    };
    const result = await retrieve(input.db, request);
    await assertSourceManifestCurrent();
    const fallbackReason =
      queryEmbedding?.reason ?? result.fallbackReason;
    const retrieval =
      fallbackReason === result.fallbackReason
        ? result
        : { ...result, fallbackReason };
    return retrieval;
  };

  const initial = await runRetrieval();
  if (input.requestedStrategy !== "lexical" || initial.evidence.length > 0) {
    return [{ retrieval: initial, fallbackReason: initial.fallbackReason }];
  }

  const taskTerms = await runRetrieval("task_terms");
  return [
    { retrieval: initial, fallbackReason: initial.fallbackReason },
    {
      retrieval: taskTerms,
      fallbackReason: "lexical_all_prompt_terms_no_match_task_terms_retry",
    },
  ];
}

/**
 * Ensure selected-source context has been retrieved before the Workspace
 * target is called. Auto prefers GraphRAG when its frozen snapshot is
 * available, then falls back to lexical retrieval. Explicit Graph remains
 * strict and never falls back to lexical.
 */
export async function ensureWorkspaceTargetSourceRetrieval(input: {
  requestedStrategy: WorkspaceRetrievalStrategy;
  sourceIds: readonly string[];
  retrievalCompleted: boolean;
  originalTask: string;
  handlers: Pick<ToolHandlers, "search_knowledge" | "search_graph_entities">;
  context: ToolContext;
}): Promise<void> {
  if (!input.sourceIds.length || input.retrievalCompleted) return;

  const searchGraph = input.handlers.search_graph_entities;
  if (
    input.requestedStrategy === "graph" ||
    (input.requestedStrategy === "auto" && searchGraph)
  ) {
    if (!searchGraph) {
      throw new Error("WORKSPACE_CHAT_GRAPH_RETRIEVAL_UNAVAILABLE");
    }
    try {
      const result = await searchGraph(
        { query: input.originalTask, limit: 5 },
        input.context,
      );
      if (
        typeof result === "object" &&
        result !== null &&
        !Array.isArray(result) &&
        "available" in result &&
        result.available === true
      ) {
        return;
      }
      if (input.requestedStrategy === "graph") {
        throw new Error("WORKSPACE_CHAT_GRAPH_RETRIEVAL_UNAVAILABLE");
      }
    } catch (error) {
      if (
        input.requestedStrategy !== "auto" ||
        !(error instanceof Error) ||
        error.message !== "WORKSPACE_CHAT_GRAPH_RETRIEVAL_UNAVAILABLE"
      ) {
        throw error;
      }
    }
  }

  const searchKnowledge = input.handlers.search_knowledge;
  if (!searchKnowledge) {
    throw new Error("WORKSPACE_CHAT_SOURCE_RETRIEVAL_UNAVAILABLE");
  }
  await searchKnowledge(
    { query: input.originalTask, sourceIds: [...input.sourceIds], limit: 5 },
    input.context,
  );
}
