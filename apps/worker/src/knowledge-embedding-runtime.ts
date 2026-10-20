import { IdSchema, type WorkspaceSourceManifest } from "@promptlab/contracts";
import {
  getKnowledgeEmbeddingReadiness,
  isWorkspaceSourceManifestCurrent,
  listKnowledgeChunksForEmbedding,
  upsertKnowledgeChunkEmbedding,
  validateKnowledgeEmbeddingVector,
  type Database,
  type KnowledgeEmbeddingProfileInput,
  type KnowledgeEmbeddingReadinessStatus,
} from "@promptlab/db";
import {
  ProviderRequestError,
  type CampusEmbeddingResult,
} from "@promptlab/providers";
import { z } from "zod";

export const KnowledgeEmbeddingJobSchema = z.strictObject({
  projectId: IdSchema,
  sourceId: IdSchema,
  documentVersionId: IdSchema,
});

export type KnowledgeEmbeddingJob = z.infer<typeof KnowledgeEmbeddingJobSchema>;

export interface KnowledgeEmbeddingAdapter {
  embed(
    text: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CampusEmbeddingResult>;
}

export interface KnowledgeEmbeddingRuntimeDependencies {
  listChunks: typeof listKnowledgeChunksForEmbedding;
  upsertEmbedding: typeof upsertKnowledgeChunkEmbedding;
  getReadiness: typeof getKnowledgeEmbeddingReadiness;
  isSourceManifestCurrent: typeof isWorkspaceSourceManifestCurrent;
}

const defaultDependencies: KnowledgeEmbeddingRuntimeDependencies = {
  listChunks: listKnowledgeChunksForEmbedding,
  upsertEmbedding: upsertKnowledgeChunkEmbedding,
  getReadiness: getKnowledgeEmbeddingReadiness,
  isSourceManifestCurrent: isWorkspaceSourceManifestCurrent,
};

const EMBEDDING_PROFILE_VERSIONS = {
  chunkingVersion: "knowledge-chunks-v1",
  preprocessingVersion: "identity-v1",
  queryTemplateVersion: "raw-text-v1",
  documentTemplateVersion: "raw-text-v1",
} as const;

export interface KnowledgeEmbeddingProfileResolution {
  profile: KnowledgeEmbeddingProfileInput | null;
  vector: number[] | null;
  reason: string | null;
}

function resolveProfile(
  result: CampusEmbeddingResult,
  requestedModel: string,
): KnowledgeEmbeddingProfileResolution {
  if (result.requestedModel !== requestedModel) {
    return {
      profile: null,
      vector: null,
      reason: "embedding_requested_model_mismatch",
    };
  }

  if (result.dimensions !== 768) {
    return {
      profile: null,
      vector: null,
      reason: "embedding_profile_invalid",
    };
  }

  try {
    const vector = validateKnowledgeEmbeddingVector([...result.vector]);
    const observedModel = result.responseModel?.trim() || "unreported";
    if (observedModel.length > 200) {
      return {
        profile: null,
        vector: null,
        reason: "embedding_profile_invalid",
      };
    }
    return {
      profile: {
        provider: "campus",
        requestedModel,
        observedModel,
        modelDigest: null,
        dimensions: result.dimensions,
        ...EMBEDDING_PROFILE_VERSIONS,
      },
      vector,
      reason: null,
    };
  } catch {
    return {
      profile: null,
      vector: null,
      reason: "embedding_response_invalid",
    };
  }
}

function sameProfile(
  left: KnowledgeEmbeddingProfileInput,
  right: KnowledgeEmbeddingProfileInput,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function embeddingFailureReason(error: unknown): string {
  if (error instanceof ProviderRequestError) {
    return `campus_embedding_${error.code.toLowerCase()}`;
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    switch (error.code) {
      case "SOURCE_NOT_ELIGIBLE":
        return "source_version_not_current";
      case "SOURCE_NOT_FOUND":
        return "source_version_not_found";
      case "CHUNK_CHECKSUM_MISMATCH":
        return "source_chunk_changed";
      case "PROFILE_INVALID":
        return "embedding_profile_invalid";
      case "VECTOR_INVALID":
        return "embedding_response_invalid";
      default:
        return "knowledge_embedding_persistence_failed";
    }
  }
  return "knowledge_embedding_job_failed";
}

export function knowledgeEmbeddingJobFromOutbox(
  eventType: string,
  payload: unknown,
): KnowledgeEmbeddingJob | null {
  if (eventType !== "knowledge.embedding.enqueue") return null;
  const parsed = KnowledgeEmbeddingJobSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export interface KnowledgeEmbeddingJobOutcome {
  projectId: string;
  sourceId: string;
  documentVersionId: string;
  status: KnowledgeEmbeddingReadinessStatus | "not_checked" | "failed";
  chunkCount: number;
  embeddedChunkCount: number;
  profile: KnowledgeEmbeddingProfileInput | null;
  reason: string | null;
  retryable?: boolean;
}

export async function executeKnowledgeEmbeddingJob(input: {
  db: Database;
  job: KnowledgeEmbeddingJob;
  adapter: KnowledgeEmbeddingAdapter | null;
  requestedModel: string | null;
  unavailableReason?: string | null;
  dependencies?: KnowledgeEmbeddingRuntimeDependencies;
}): Promise<KnowledgeEmbeddingJobOutcome> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const base = {
    projectId: input.job.projectId,
    sourceId: input.job.sourceId,
    documentVersionId: input.job.documentVersionId,
  };

  if (!input.adapter || !input.requestedModel) {
    return {
      ...base,
      status: "not_checked",
      chunkCount: 0,
      embeddedChunkCount: 0,
      profile: null,
      reason: input.unavailableReason ?? "embedding_endpoint_not_configured",
    };
  }

  const source = {
    projectId: input.job.projectId,
    sourceId: input.job.sourceId,
    documentVersionId: input.job.documentVersionId,
  };
  const chunks = await dependencies.listChunks(input.db, source);
  if (!chunks.length) {
    return {
      ...base,
      status: "blocked",
      chunkCount: 0,
      embeddedChunkCount: 0,
      profile: null,
      reason: "source_version_not_current",
    };
  }

  let profile: KnowledgeEmbeddingProfileInput | null = null;
  let embeddedChunkCount = 0;
  const readinessOutcome = async (
    reason: string | null,
    fallbackStatus: KnowledgeEmbeddingJobOutcome["status"],
  ): Promise<KnowledgeEmbeddingJobOutcome> => {
    if (!profile) {
      return {
        ...base,
        status: fallbackStatus,
        chunkCount: chunks.length,
        embeddedChunkCount,
        profile: null,
        reason,
      };
    }
    try {
      const [readiness] = await dependencies.getReadiness(input.db, {
        projectId: input.job.projectId,
        selectedSourceIds: [input.job.sourceId],
        profile,
      });
      return {
        ...base,
        status: readiness?.status ?? fallbackStatus,
        chunkCount: readiness?.chunkCount ?? chunks.length,
        embeddedChunkCount: readiness?.embeddedChunkCount ?? embeddedChunkCount,
        profile,
        reason:
          reason ??
          (readiness?.status === "ready" ? null : "embedding_index_incomplete"),
      };
    } catch {
      return {
        ...base,
        status: "failed",
        chunkCount: chunks.length,
        embeddedChunkCount,
        profile,
        reason: reason ?? "embedding_readiness_unavailable",
      };
    }
  };

  for (const chunk of chunks) {
    try {
      // This query rechecks active-version eligibility immediately before each
      // source-text egress.
      const currentChunks = await dependencies.listChunks(input.db, source);
      const current = currentChunks.find(
        (candidate) =>
          candidate.chunkId === chunk.chunkId &&
          candidate.chunkChecksum === chunk.chunkChecksum,
      );
      if (!current) {
        return readinessOutcome(
          "source_version_not_current",
          embeddedChunkCount ? "partial" : "blocked",
        );
      }

      const result = await input.adapter.embed(current.content);
      const resolution = resolveProfile(result, input.requestedModel);
      if (!resolution.profile || !resolution.vector) {
        return readinessOutcome(
          resolution.reason ?? "embedding_response_invalid",
          "failed",
        );
      }
      if (profile && !sameProfile(profile, resolution.profile)) {
        return readinessOutcome(
          "embedding_profile_changed_during_job",
          "failed",
        );
      }
      profile ??= resolution.profile;

      await dependencies.upsertEmbedding(input.db, {
        projectId: input.job.projectId,
        documentVersionId: input.job.documentVersionId,
        chunkId: current.chunkId,
        chunkChecksum: current.chunkChecksum,
        profile,
        vector: resolution.vector,
      });
      embeddedChunkCount += 1;
    } catch (error) {
      const reason = embeddingFailureReason(error);
      const outcome = await readinessOutcome(reason, "failed");
      const retryable =
        (error instanceof ProviderRequestError && error.retryable) ||
        reason === "knowledge_embedding_persistence_failed";
      return retryable ? { ...outcome, retryable: true } : outcome;
    }
  }

  return readinessOutcome(null, "not_indexed");
}

export interface WorkspaceQueryEmbeddingOutcome {
  embedding: {
    profile: KnowledgeEmbeddingProfileInput;
    queryVector: number[];
  } | null;
  reason: string | null;
}

export async function createWorkspaceQueryEmbedding(input: {
  db: Database;
  projectId: string;
  query: string;
  selectedSourceIds: readonly string[];
  sourceManifest: WorkspaceSourceManifest;
  adapter: KnowledgeEmbeddingAdapter | null;
  requestedModel: string | null;
  unavailableReason?: string | null;
  beforeEgress: () => Promise<void>;
  dependencies?: KnowledgeEmbeddingRuntimeDependencies;
}): Promise<WorkspaceQueryEmbeddingOutcome> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const selectedSourceIds = [...new Set(input.selectedSourceIds)];
  const manifestBySource = new Map(
    input.sourceManifest.sources
      .filter((source) => selectedSourceIds.includes(source.documentId))
      .map((source) => [source.documentId, source]),
  );
  if (
    manifestBySource.size !== selectedSourceIds.length ||
    selectedSourceIds.some((sourceId) => !manifestBySource.has(sourceId))
  ) {
    return { embedding: null, reason: "source_manifest_missing" };
  }
  if (!input.adapter || !input.requestedModel) {
    return {
      embedding: null,
      reason: input.unavailableReason ?? "embedding_endpoint_not_configured",
    };
  }

  try {
    await input.beforeEgress();
    const result = await input.adapter.embed(input.query);
    const resolution = resolveProfile(result, input.requestedModel);
    if (!resolution.profile || !resolution.vector) {
      return {
        embedding: null,
        reason: resolution.reason ?? "embedding_response_invalid",
      };
    }
    const readiness = await dependencies.getReadiness(input.db, {
      projectId: input.projectId,
      selectedSourceIds,
      profile: resolution.profile,
    });
    if (
      !readiness.some((source) => ["ready", "partial"].includes(source.status))
    ) {
      return { embedding: null, reason: "semantic_index_not_ready" };
    }
    return {
      embedding: {
        profile: resolution.profile,
        queryVector: resolution.vector,
      },
      reason: null,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "WORKSPACE_SOURCE_MANIFEST_CHANGED"
    ) {
      throw error;
    }
    return { embedding: null, reason: embeddingFailureReason(error) };
  }
}
