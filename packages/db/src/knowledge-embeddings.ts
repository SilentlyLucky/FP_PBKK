import { createHash } from "node:crypto";

import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import * as schema from "./schema.ts";
import type { Database } from "./index.ts";

type QueryDatabase = Pick<Database, "select" | "insert">;
export type KnowledgeEmbeddingReadDatabase = Pick<Database, "select">;

export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 768;
export const MAX_KNOWLEDGE_EMBEDDING_SEARCH_RESULTS = 100;

export interface KnowledgeEmbeddingProfileInput {
  provider: string;
  requestedModel: string;
  observedModel: string;
  modelDigest?: string | null;
  dimensions: number;
  chunkingVersion: string;
  preprocessingVersion: string;
  queryTemplateVersion: string;
  documentTemplateVersion: string;
}

export interface KnowledgeChunkEmbeddingInput {
  projectId: string;
  documentVersionId: string;
  chunkId: string;
  chunkChecksum: string;
  profile: KnowledgeEmbeddingProfileInput;
  vector: number[];
}

export interface KnowledgeChunkEmbeddingRecord {
  id: string;
  projectId: string;
  documentVersionId: string;
  chunkId: string;
  profileId: string;
  profileChecksum: string;
  chunkChecksum: string;
  vector: number[];
}

export interface SearchKnowledgeEmbeddingsInput {
  projectId: string;
  selectedSourceIds: string[];
  profile: KnowledgeEmbeddingProfileInput;
  queryVector: number[];
  limit?: number;
}

export interface KnowledgeEmbeddingSearchResult {
  sourceId: string;
  documentId: string;
  documentName: string;
  sourceRef: string | null;
  sourceMetadata: Record<string, unknown>;
  documentVersionId: string;
  documentVersion: number;
  chunkId: string;
  chunkChecksum: string;
  pageNumber: number | null;
  content: string;
  sourceChecksum: string;
  distance: number;
  similarity: number;
}

export interface KnowledgeEmbeddingReadinessInput {
  projectId: string;
  selectedSourceIds: string[];
  profile: KnowledgeEmbeddingProfileInput;
}

export type KnowledgeEmbeddingReadinessStatus =
  "ready" | "partial" | "not_indexed" | "blocked";

export interface KnowledgeEmbeddingSourceReadiness {
  sourceId: string;
  documentVersionId: string | null;
  chunkCount: number;
  embeddedChunkCount: number;
  status: KnowledgeEmbeddingReadinessStatus;
}

export type KnowledgeEmbeddingIndexReadinessStatus =
  KnowledgeEmbeddingReadinessStatus | "stale";

export interface KnowledgeEmbeddingIndexProfileReadiness {
  profileId: string;
  profileChecksum: string;
  provider: string;
  requestedModel: string;
  observedModel: string;
  modelDigest: string | null;
  dimensions: number;
  chunkingVersion: string;
  preprocessingVersion: string;
  queryTemplateVersion: string;
  documentTemplateVersion: string;
  chunkCount: number;
  embeddedChunkCount: number;
  status: "ready" | "partial";
}

export interface KnowledgeEmbeddingIndexSourceReadiness {
  sourceId: string;
  documentVersionId: string | null;
  chunkCount: number;
  staleEmbeddingCount: number;
  status: KnowledgeEmbeddingIndexReadinessStatus;
  reason: "source_permission_not_granted" | "source_version_unavailable" | null;
  retrievalProfileCompatibility: "not_verified";
  profiles: KnowledgeEmbeddingIndexProfileReadiness[];
}

export type KnowledgeEmbeddingErrorCode =
  | "PROFILE_INVALID"
  | "VECTOR_INVALID"
  | "CHUNK_CHECKSUM_INVALID"
  | "CHUNK_CHECKSUM_MISMATCH"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_NOT_ELIGIBLE"
  | "SOURCE_PERMISSION_REQUIRED"
  | "SEARCH_LIMIT_INVALID"
  | "EMBEDDING_IDEMPOTENCY_CONFLICT";

export class KnowledgeEmbeddingError extends Error {
  constructor(
    readonly code: KnowledgeEmbeddingErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "KnowledgeEmbeddingError";
  }
}

function nonEmptyVersion(
  value: string,
  field: string,
  maxLength: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new KnowledgeEmbeddingError(
      "PROFILE_INVALID",
      `Field ${field} in the embedding profile is invalid.`,
      { field, maxLength },
    );
  }
  return normalized;
}

function normalizeProfile(
  input: KnowledgeEmbeddingProfileInput,
): KnowledgeEmbeddingProfileInput & { modelDigest: string | null } {
  if (input.dimensions !== KNOWLEDGE_EMBEDDING_DIMENSIONS) {
    throw new KnowledgeEmbeddingError(
      "PROFILE_INVALID",
      `Embedding profiles must declare ${KNOWLEDGE_EMBEDDING_DIMENSIONS} dimensions.`,
      { dimensions: input.dimensions },
    );
  }
  const modelDigest = input.modelDigest?.trim() || null;
  if (modelDigest && modelDigest.length > 200) {
    throw new KnowledgeEmbeddingError(
      "PROFILE_INVALID",
      "The embedding model digest is too long.",
      { maxLength: 200 },
    );
  }
  return {
    provider: nonEmptyVersion(input.provider, "provider", 80),
    requestedModel: nonEmptyVersion(
      input.requestedModel,
      "requestedModel",
      200,
    ),
    observedModel: nonEmptyVersion(input.observedModel, "observedModel", 200),
    modelDigest,
    dimensions: input.dimensions,
    chunkingVersion: nonEmptyVersion(
      input.chunkingVersion,
      "chunkingVersion",
      120,
    ),
    preprocessingVersion: nonEmptyVersion(
      input.preprocessingVersion,
      "preprocessingVersion",
      120,
    ),
    queryTemplateVersion: nonEmptyVersion(
      input.queryTemplateVersion,
      "queryTemplateVersion",
      120,
    ),
    documentTemplateVersion: nonEmptyVersion(
      input.documentTemplateVersion,
      "documentTemplateVersion",
      120,
    ),
  };
}

export function knowledgeEmbeddingProfileChecksum(
  profileInput: KnowledgeEmbeddingProfileInput,
): string {
  const profile = normalizeProfile(profileInput);
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: profile.provider,
        requestedModel: profile.requestedModel,
        observedModel: profile.observedModel,
        modelDigest: profile.modelDigest,
        dimensions: profile.dimensions,
        chunkingVersion: profile.chunkingVersion,
        preprocessingVersion: profile.preprocessingVersion,
        queryTemplateVersion: profile.queryTemplateVersion,
        documentTemplateVersion: profile.documentTemplateVersion,
      }),
      "utf8",
    )
    .digest("hex");
}

export function validateKnowledgeEmbeddingVector(vector: number[]): number[] {
  if (
    !Array.isArray(vector) ||
    vector.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
    vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new KnowledgeEmbeddingError(
      "VECTOR_INVALID",
      `Embedding vectors must contain exactly ${KNOWLEDGE_EMBEDDING_DIMENSIONS} finite numbers.`,
      { dimensions: Array.isArray(vector) ? vector.length : null },
    );
  }
  const storedVector = vector.map(Math.fround);
  if (storedVector.every((value) => value === 0)) {
    throw new KnowledgeEmbeddingError(
      "VECTOR_INVALID",
      "Embedding vectors must have nonzero magnitude after float32 storage.",
    );
  }
  return storedVector;
}

function validateChunkChecksum(checksum: string): string {
  if (!/^[0-9a-f]{64}$/iu.test(checksum)) {
    throw new KnowledgeEmbeddingError(
      "CHUNK_CHECKSUM_INVALID",
      "Chunk checksums must be 64 hexadecimal characters.",
    );
  }
  return checksum.toLowerCase();
}

function serializeVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function vectorsEqualAfterFloat32Storage(
  left: number[],
  right: number[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) => Math.fround(value) === Math.fround(right[index]!),
    )
  );
}

function isStoredVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === KNOWLEDGE_EMBEDDING_DIMENSIONS &&
    value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    value.some((item) => item !== 0)
  );
}

async function upsertKnowledgeChunkEmbeddingInTransaction(
  tx: QueryDatabase,
  input: KnowledgeChunkEmbeddingInput,
): Promise<KnowledgeChunkEmbeddingRecord> {
  const profile = normalizeProfile(input.profile);
  const profileChecksum = knowledgeEmbeddingProfileChecksum(profile);
  const chunkChecksum = validateChunkChecksum(input.chunkChecksum);
  const vector = validateKnowledgeEmbeddingVector(input.vector);

  const [source] = await tx
    .select({
      chunkChecksum: schema.chunks.contentHash,
      sourceActiveVersionId: schema.documents.activeVersionId,
      sourceDeletedAt: schema.documents.deletedAt,
      sourcePermission: schema.documents.trust,
      versionEligible: schema.documentVersions.eligible,
      versionRetiredAt: schema.documentVersions.retiredAt,
    })
    .from(schema.chunks)
    .innerJoin(
      schema.documentVersions,
      and(
        eq(schema.documentVersions.projectId, schema.chunks.projectId),
        eq(schema.documentVersions.id, schema.chunks.documentVersionId),
      ),
    )
    .innerJoin(
      schema.documents,
      and(
        eq(schema.documents.projectId, schema.documentVersions.projectId),
        eq(schema.documents.id, schema.documentVersions.documentId),
      ),
    )
    .where(
      and(
        eq(schema.chunks.projectId, input.projectId),
        eq(schema.chunks.documentVersionId, input.documentVersionId),
        eq(schema.chunks.id, input.chunkId),
      ),
    )
    .limit(1)
    .for("update");
  if (!source) {
    throw new KnowledgeEmbeddingError(
      "SOURCE_NOT_FOUND",
      "The source version or chunk for this embedding is unavailable.",
    );
  }
  if (source.chunkChecksum.toLowerCase() !== chunkChecksum) {
    throw new KnowledgeEmbeddingError(
      "CHUNK_CHECKSUM_MISMATCH",
      "The embedding checksum does not match the stored chunk.",
      { expected: source.chunkChecksum, actual: chunkChecksum },
    );
  }
  if (source.sourcePermission !== "campus_indexer_allowed") {
    throw new KnowledgeEmbeddingError(
      "SOURCE_PERMISSION_REQUIRED",
      "Embedding persistence requires the source's existing Campus permission.",
    );
  }
  if (
    source.sourceDeletedAt ||
    source.sourceActiveVersionId !== input.documentVersionId ||
    !source.versionEligible ||
    source.versionRetiredAt
  ) {
    throw new KnowledgeEmbeddingError(
      "SOURCE_NOT_ELIGIBLE",
      "Embeddings can only be persisted for the active eligible source version.",
    );
  }

  await tx
    .insert(schema.knowledgeEmbeddingProfiles)
    .values({ projectId: input.projectId, ...profile, profileChecksum })
    .onConflictDoNothing({
      target: [
        schema.knowledgeEmbeddingProfiles.projectId,
        schema.knowledgeEmbeddingProfiles.profileChecksum,
      ],
    });
  const [storedProfile] = await tx
    .select({
      id: schema.knowledgeEmbeddingProfiles.id,
      profileChecksum: schema.knowledgeEmbeddingProfiles.profileChecksum,
    })
    .from(schema.knowledgeEmbeddingProfiles)
    .where(
      and(
        eq(schema.knowledgeEmbeddingProfiles.projectId, input.projectId),
        eq(schema.knowledgeEmbeddingProfiles.profileChecksum, profileChecksum),
      ),
    )
    .limit(1);
  if (!storedProfile)
    throw new Error("Embedding profile insert returned no row");

  const key = and(
    eq(schema.knowledgeChunkEmbeddings.projectId, input.projectId),
    eq(
      schema.knowledgeChunkEmbeddings.documentVersionId,
      input.documentVersionId,
    ),
    eq(schema.knowledgeChunkEmbeddings.chunkId, input.chunkId),
    eq(schema.knowledgeChunkEmbeddings.profileId, storedProfile.id),
    eq(schema.knowledgeChunkEmbeddings.profileChecksum, profileChecksum),
    eq(schema.knowledgeChunkEmbeddings.chunkChecksum, chunkChecksum),
  );
  const [inserted] = await tx
    .insert(schema.knowledgeChunkEmbeddings)
    .values({
      projectId: input.projectId,
      documentVersionId: input.documentVersionId,
      chunkId: input.chunkId,
      profileId: storedProfile.id,
      profileChecksum,
      chunkChecksum,
      embedding: vector,
    })
    .onConflictDoNothing({
      target: [
        schema.knowledgeChunkEmbeddings.projectId,
        schema.knowledgeChunkEmbeddings.documentVersionId,
        schema.knowledgeChunkEmbeddings.chunkId,
        schema.knowledgeChunkEmbeddings.profileId,
        schema.knowledgeChunkEmbeddings.profileChecksum,
        schema.knowledgeChunkEmbeddings.chunkChecksum,
      ],
    })
    .returning({
      id: schema.knowledgeChunkEmbeddings.id,
      embedding: schema.knowledgeChunkEmbeddings.embedding,
    });
  const [stored] = inserted
    ? [inserted]
    : await tx
        .select({
          id: schema.knowledgeChunkEmbeddings.id,
          embedding: schema.knowledgeChunkEmbeddings.embedding,
        })
        .from(schema.knowledgeChunkEmbeddings)
        .where(key)
        .limit(1);
  if (!stored || !isStoredVector(stored.embedding)) {
    throw new Error("Embedding insert returned no valid row");
  }
  if (!vectorsEqualAfterFloat32Storage(stored.embedding, vector)) {
    throw new KnowledgeEmbeddingError(
      "EMBEDDING_IDEMPOTENCY_CONFLICT",
      "A different vector already exists for this source version, chunk, profile, and checksum.",
      { embeddingId: stored.id },
    );
  }
  return {
    id: stored.id,
    projectId: input.projectId,
    documentVersionId: input.documentVersionId,
    chunkId: input.chunkId,
    profileId: storedProfile.id,
    profileChecksum,
    chunkChecksum,
    vector: stored.embedding,
  };
}

export async function upsertKnowledgeChunkEmbedding(
  db: Database,
  input: KnowledgeChunkEmbeddingInput,
): Promise<KnowledgeChunkEmbeddingRecord> {
  return db.transaction((tx) =>
    upsertKnowledgeChunkEmbeddingInTransaction(tx, input),
  );
}

export async function searchKnowledgeEmbeddings(
  db: KnowledgeEmbeddingReadDatabase,
  input: SearchKnowledgeEmbeddingsInput,
): Promise<KnowledgeEmbeddingSearchResult[]> {
  const queryVector = validateKnowledgeEmbeddingVector(input.queryVector);
  const profileChecksum = knowledgeEmbeddingProfileChecksum(input.profile);
  const limit = input.limit ?? 10;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_KNOWLEDGE_EMBEDDING_SEARCH_RESULTS
  ) {
    throw new KnowledgeEmbeddingError(
      "SEARCH_LIMIT_INVALID",
      `Search limits must be from 1 to ${MAX_KNOWLEDGE_EMBEDDING_SEARCH_RESULTS}.`,
      { limit },
    );
  }
  if (input.selectedSourceIds.length === 0) return [];

  const distance = sql<number>`(${schema.knowledgeChunkEmbeddings.embedding} <=> ${serializeVector(queryVector)}::vector)::double precision`;
  const rows = await db
    .select({
      sourceId: schema.documents.id,
      documentId: schema.documents.id,
      documentName: schema.documents.displayName,
      sourceRef: schema.documentVersions.sourceRef,
      sourceMetadata: schema.documentVersions.sourceMetadata,
      documentVersionId: schema.knowledgeChunkEmbeddings.documentVersionId,
      documentVersion: schema.documentVersions.version,
      chunkId: schema.knowledgeChunkEmbeddings.chunkId,
      chunkChecksum: schema.knowledgeChunkEmbeddings.chunkChecksum,
      pageNumber: schema.chunks.pageNumber,
      content: schema.chunks.content,
      sourceChecksum: schema.documentVersions.checksum,
      distance,
      similarity: sql<number>`1.0 - ${distance}`,
    })
    .from(schema.knowledgeChunkEmbeddings)
    .innerJoin(
      schema.knowledgeEmbeddingProfiles,
      and(
        eq(
          schema.knowledgeEmbeddingProfiles.projectId,
          schema.knowledgeChunkEmbeddings.projectId,
        ),
        eq(
          schema.knowledgeEmbeddingProfiles.id,
          schema.knowledgeChunkEmbeddings.profileId,
        ),
        eq(
          schema.knowledgeEmbeddingProfiles.profileChecksum,
          schema.knowledgeChunkEmbeddings.profileChecksum,
        ),
      ),
    )
    .innerJoin(
      schema.documentVersions,
      and(
        eq(
          schema.documentVersions.projectId,
          schema.knowledgeChunkEmbeddings.projectId,
        ),
        eq(
          schema.documentVersions.id,
          schema.knowledgeChunkEmbeddings.documentVersionId,
        ),
      ),
    )
    .innerJoin(
      schema.documents,
      and(
        eq(schema.documents.projectId, schema.documentVersions.projectId),
        eq(schema.documents.id, schema.documentVersions.documentId),
      ),
    )
    .innerJoin(
      schema.chunks,
      and(
        eq(schema.chunks.projectId, schema.knowledgeChunkEmbeddings.projectId),
        eq(
          schema.chunks.documentVersionId,
          schema.knowledgeChunkEmbeddings.documentVersionId,
        ),
        eq(schema.chunks.id, schema.knowledgeChunkEmbeddings.chunkId),
        eq(
          schema.chunks.contentHash,
          schema.knowledgeChunkEmbeddings.chunkChecksum,
        ),
      ),
    )
    .where(
      and(
        eq(schema.knowledgeChunkEmbeddings.projectId, input.projectId),
        eq(schema.knowledgeChunkEmbeddings.profileChecksum, profileChecksum),
        inArray(schema.documents.id, input.selectedSourceIds),
        eq(
          schema.documents.activeVersionId,
          schema.knowledgeChunkEmbeddings.documentVersionId,
        ),
        eq(schema.documents.trust, "campus_indexer_allowed"),
        isNull(schema.documents.deletedAt),
        eq(schema.documentVersions.eligible, true),
        isNull(schema.documentVersions.retiredAt),
      ),
    )
    .orderBy(asc(distance), asc(schema.chunks.ordinal), asc(schema.chunks.id))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    distance: Number(row.distance),
    similarity: Number(row.similarity),
  }));
}

export async function listKnowledgeChunksForEmbedding(
  db: KnowledgeEmbeddingReadDatabase,
  input: { projectId: string; sourceId: string; documentVersionId: string },
): Promise<Array<{ chunkId: string; chunkChecksum: string; content: string }>> {
  const rows = await db
    .select({
      chunkId: schema.chunks.id,
      chunkChecksum: schema.chunks.contentHash,
      content: schema.chunks.content,
    })
    .from(schema.chunks)
    .innerJoin(
      schema.documentVersions,
      and(
        eq(schema.documentVersions.projectId, schema.chunks.projectId),
        eq(schema.documentVersions.id, schema.chunks.documentVersionId),
      ),
    )
    .innerJoin(
      schema.documents,
      and(
        eq(schema.documents.projectId, schema.documentVersions.projectId),
        eq(schema.documents.id, schema.documentVersions.documentId),
        eq(schema.documents.activeVersionId, schema.documentVersions.id),
      ),
    )
    .where(
      and(
        eq(schema.chunks.projectId, input.projectId),
        eq(schema.documents.id, input.sourceId),
        eq(schema.documentVersions.id, input.documentVersionId),
        eq(schema.documents.trust, "campus_indexer_allowed"),
        isNull(schema.documents.deletedAt),
        eq(schema.documentVersions.eligible, true),
        isNull(schema.documentVersions.retiredAt),
      ),
    )
    .orderBy(asc(schema.chunks.ordinal));
  return rows;
}

export async function getKnowledgeEmbeddingIndexReadiness(
  db: KnowledgeEmbeddingReadDatabase,
  input: { projectId: string; selectedSourceIds: string[] },
): Promise<KnowledgeEmbeddingIndexSourceReadiness[]> {
  const selectedSourceIds = [...new Set(input.selectedSourceIds)];
  if (!selectedSourceIds.length) return [];

  const coverageRows = await db
    .select({
      sourceId: schema.documents.id,
      activeVersionId: schema.documents.activeVersionId,
      permission: schema.documents.trust,
      deletedAt: schema.documents.deletedAt,
      documentVersionId: schema.documentVersions.id,
      eligible: schema.documentVersions.eligible,
      retiredAt: schema.documentVersions.retiredAt,
      chunkCount: sql<number>`count(distinct ${schema.chunks.id})::int`,
      profileId: schema.knowledgeEmbeddingProfiles.id,
      profileChecksum: schema.knowledgeEmbeddingProfiles.profileChecksum,
      provider: schema.knowledgeEmbeddingProfiles.provider,
      requestedModel: schema.knowledgeEmbeddingProfiles.requestedModel,
      observedModel: schema.knowledgeEmbeddingProfiles.observedModel,
      modelDigest: schema.knowledgeEmbeddingProfiles.modelDigest,
      dimensions: schema.knowledgeEmbeddingProfiles.dimensions,
      chunkingVersion: schema.knowledgeEmbeddingProfiles.chunkingVersion,
      preprocessingVersion:
        schema.knowledgeEmbeddingProfiles.preprocessingVersion,
      queryTemplateVersion:
        schema.knowledgeEmbeddingProfiles.queryTemplateVersion,
      documentTemplateVersion:
        schema.knowledgeEmbeddingProfiles.documentTemplateVersion,
      embeddedChunkCount: sql<number>`count(distinct ${schema.knowledgeChunkEmbeddings.chunkId})::int`,
    })
    .from(schema.documents)
    .leftJoin(
      schema.documentVersions,
      and(
        eq(schema.documentVersions.projectId, schema.documents.projectId),
        eq(schema.documentVersions.documentId, schema.documents.id),
        eq(schema.documentVersions.id, schema.documents.activeVersionId),
      ),
    )
    .leftJoin(
      schema.chunks,
      and(
        eq(schema.chunks.projectId, schema.documents.projectId),
        eq(schema.chunks.documentVersionId, schema.documentVersions.id),
      ),
    )
    .leftJoin(
      schema.knowledgeChunkEmbeddings,
      and(
        eq(schema.knowledgeChunkEmbeddings.projectId, schema.chunks.projectId),
        eq(
          schema.knowledgeChunkEmbeddings.documentVersionId,
          schema.chunks.documentVersionId,
        ),
        eq(schema.knowledgeChunkEmbeddings.chunkId, schema.chunks.id),
        eq(
          schema.knowledgeChunkEmbeddings.chunkChecksum,
          schema.chunks.contentHash,
        ),
        eq(schema.documents.trust, "campus_indexer_allowed"),
        isNull(schema.documents.deletedAt),
        eq(schema.documentVersions.eligible, true),
        isNull(schema.documentVersions.retiredAt),
      ),
    )
    .leftJoin(
      schema.knowledgeEmbeddingProfiles,
      and(
        eq(
          schema.knowledgeEmbeddingProfiles.projectId,
          schema.knowledgeChunkEmbeddings.projectId,
        ),
        eq(
          schema.knowledgeEmbeddingProfiles.id,
          schema.knowledgeChunkEmbeddings.profileId,
        ),
        eq(
          schema.knowledgeEmbeddingProfiles.profileChecksum,
          schema.knowledgeChunkEmbeddings.profileChecksum,
        ),
      ),
    )
    .where(
      and(
        eq(schema.documents.projectId, input.projectId),
        inArray(schema.documents.id, selectedSourceIds),
      ),
    )
    .groupBy(
      schema.documents.id,
      schema.documents.activeVersionId,
      schema.documents.trust,
      schema.documents.deletedAt,
      schema.documentVersions.id,
      schema.documentVersions.eligible,
      schema.documentVersions.retiredAt,
      schema.knowledgeEmbeddingProfiles.id,
      schema.knowledgeEmbeddingProfiles.profileChecksum,
      schema.knowledgeEmbeddingProfiles.provider,
      schema.knowledgeEmbeddingProfiles.requestedModel,
      schema.knowledgeEmbeddingProfiles.observedModel,
      schema.knowledgeEmbeddingProfiles.modelDigest,
      schema.knowledgeEmbeddingProfiles.dimensions,
      schema.knowledgeEmbeddingProfiles.chunkingVersion,
      schema.knowledgeEmbeddingProfiles.preprocessingVersion,
      schema.knowledgeEmbeddingProfiles.queryTemplateVersion,
      schema.knowledgeEmbeddingProfiles.documentTemplateVersion,
    );

  const chunkCountRows = await db
    .select({
      sourceId: schema.documents.id,
      chunkCount: sql<number>`count(distinct ${schema.chunks.id})::int`,
    })
    .from(schema.documents)
    .leftJoin(
      schema.chunks,
      and(
        eq(schema.chunks.projectId, schema.documents.projectId),
        eq(schema.chunks.documentVersionId, schema.documents.activeVersionId),
      ),
    )
    .where(
      and(
        eq(schema.documents.projectId, input.projectId),
        inArray(schema.documents.id, selectedSourceIds),
      ),
    )
    .groupBy(schema.documents.id);

  const staleRows = await db
    .select({
      sourceId: schema.documents.id,
      staleEmbeddingCount: sql<number>`count(distinct ${schema.knowledgeChunkEmbeddings.id})::int`,
    })
    .from(schema.knowledgeChunkEmbeddings)
    .innerJoin(
      schema.documentVersions,
      and(
        eq(
          schema.documentVersions.projectId,
          schema.knowledgeChunkEmbeddings.projectId,
        ),
        eq(
          schema.documentVersions.id,
          schema.knowledgeChunkEmbeddings.documentVersionId,
        ),
      ),
    )
    .innerJoin(
      schema.documents,
      and(
        eq(schema.documents.projectId, schema.documentVersions.projectId),
        eq(schema.documents.id, schema.documentVersions.documentId),
      ),
    )
    .leftJoin(
      schema.chunks,
      and(
        eq(schema.chunks.projectId, schema.knowledgeChunkEmbeddings.projectId),
        eq(
          schema.chunks.documentVersionId,
          schema.knowledgeChunkEmbeddings.documentVersionId,
        ),
        eq(schema.chunks.id, schema.knowledgeChunkEmbeddings.chunkId),
        eq(
          schema.chunks.contentHash,
          schema.knowledgeChunkEmbeddings.chunkChecksum,
        ),
      ),
    )
    .where(
      and(
        eq(schema.knowledgeChunkEmbeddings.projectId, input.projectId),
        inArray(schema.documents.id, selectedSourceIds),
        or(
          isNull(schema.documents.activeVersionId),
          ne(
            schema.knowledgeChunkEmbeddings.documentVersionId,
            schema.documents.activeVersionId,
          ),
          isNull(schema.chunks.id),
        ),
      ),
    )
    .groupBy(schema.documents.id);

  const rowsBySource = new Map<string, typeof coverageRows>();
  for (const row of coverageRows) {
    const rows = rowsBySource.get(row.sourceId) ?? [];
    rows.push(row);
    rowsBySource.set(row.sourceId, rows);
  }
  const staleCountBySource = new Map(
    staleRows.map((row) => [row.sourceId, Number(row.staleEmbeddingCount)]),
  );
  const chunkCountBySource = new Map(
    chunkCountRows.map((row) => [row.sourceId, Number(row.chunkCount)]),
  );

  return selectedSourceIds.map((sourceId) => {
    const rows = rowsBySource.get(sourceId) ?? [];
    const source = rows[0];
    const chunkCount =
      chunkCountBySource.get(sourceId) ?? Number(source?.chunkCount ?? 0);
    const staleEmbeddingCount = staleCountBySource.get(sourceId) ?? 0;
    const current = Boolean(
      source &&
      source.permission === "campus_indexer_allowed" &&
      !source.deletedAt &&
      source.documentVersionId &&
      source.activeVersionId === source.documentVersionId &&
      source.eligible &&
      !source.retiredAt,
    );
    const profiles = rows.flatMap((row) => {
      if (!row.profileId || !row.profileChecksum) return [];
      const embeddedChunkCount = Number(row.embeddedChunkCount);
      if (!embeddedChunkCount) return [];
      return [
        {
          profileId: row.profileId,
          profileChecksum: row.profileChecksum,
          provider: row.provider!,
          requestedModel: row.requestedModel!,
          observedModel: row.observedModel!,
          modelDigest: row.modelDigest,
          dimensions: row.dimensions!,
          chunkingVersion: row.chunkingVersion!,
          preprocessingVersion: row.preprocessingVersion!,
          queryTemplateVersion: row.queryTemplateVersion!,
          documentTemplateVersion: row.documentTemplateVersion!,
          chunkCount,
          embeddedChunkCount,
          status:
            embeddedChunkCount >= chunkCount
              ? ("ready" as const)
              : ("partial" as const),
        },
      ];
    });
    const status: KnowledgeEmbeddingIndexReadinessStatus = !current
      ? "blocked"
      : profiles.some((profile) => profile.status === "ready")
        ? "ready"
        : profiles.length
          ? "partial"
          : staleEmbeddingCount
            ? "stale"
            : "not_indexed";

    return {
      sourceId,
      documentVersionId: current ? (source?.documentVersionId ?? null) : null,
      chunkCount: current ? chunkCount : 0,
      staleEmbeddingCount,
      status,
      reason: current
        ? null
        : !source
          ? "source_version_unavailable"
          : source.permission !== "campus_indexer_allowed"
            ? "source_permission_not_granted"
            : "source_version_unavailable",
      retrievalProfileCompatibility: "not_verified" as const,
      profiles,
    };
  });
}

export async function getKnowledgeEmbeddingReadiness(
  db: KnowledgeEmbeddingReadDatabase,
  input: KnowledgeEmbeddingReadinessInput,
): Promise<KnowledgeEmbeddingSourceReadiness[]> {
  const selectedSourceIds = [...new Set(input.selectedSourceIds)];
  if (!selectedSourceIds.length) return [];
  const profileChecksum = knowledgeEmbeddingProfileChecksum(input.profile);
  const sources = await db
    .select({
      sourceId: schema.documents.id,
      activeVersionId: schema.documents.activeVersionId,
      permission: schema.documents.trust,
      deletedAt: schema.documents.deletedAt,
      documentVersionId: schema.documentVersions.id,
      eligible: schema.documentVersions.eligible,
      retiredAt: schema.documentVersions.retiredAt,
    })
    .from(schema.documents)
    .leftJoin(
      schema.documentVersions,
      and(
        eq(schema.documentVersions.projectId, schema.documents.projectId),
        eq(schema.documentVersions.documentId, schema.documents.id),
        eq(schema.documentVersions.id, schema.documents.activeVersionId),
      ),
    )
    .where(
      and(
        eq(schema.documents.projectId, input.projectId),
        inArray(schema.documents.id, selectedSourceIds),
      ),
    );

  const sourceById = new Map(
    sources.map((source) => [source.sourceId, source]),
  );
  const indexableVersionIds = sources
    .filter(
      (source) =>
        source.permission === "campus_indexer_allowed" &&
        !source.deletedAt &&
        source.documentVersionId &&
        source.activeVersionId === source.documentVersionId &&
        source.eligible &&
        !source.retiredAt,
    )
    .map((source) => source.documentVersionId!);
  const counts = indexableVersionIds.length
    ? await db
        .select({
          documentVersionId: schema.chunks.documentVersionId,
          chunkCount: sql<number>`count(distinct ${schema.chunks.id})::int`,
          embeddedChunkCount: sql<number>`count(distinct ${schema.knowledgeChunkEmbeddings.chunkId})::int`,
        })
        .from(schema.chunks)
        .leftJoin(
          schema.knowledgeChunkEmbeddings,
          and(
            eq(
              schema.knowledgeChunkEmbeddings.projectId,
              schema.chunks.projectId,
            ),
            eq(
              schema.knowledgeChunkEmbeddings.documentVersionId,
              schema.chunks.documentVersionId,
            ),
            eq(schema.knowledgeChunkEmbeddings.chunkId, schema.chunks.id),
            eq(
              schema.knowledgeChunkEmbeddings.chunkChecksum,
              schema.chunks.contentHash,
            ),
            eq(
              schema.knowledgeChunkEmbeddings.profileChecksum,
              profileChecksum,
            ),
          ),
        )
        .where(
          and(
            eq(schema.chunks.projectId, input.projectId),
            inArray(schema.chunks.documentVersionId, indexableVersionIds),
          ),
        )
        .groupBy(schema.chunks.documentVersionId)
    : [];
  const countByVersion = new Map(
    counts.map((row) => [
      row.documentVersionId,
      {
        chunkCount: Number(row.chunkCount),
        embeddedChunkCount: Number(row.embeddedChunkCount),
      },
    ]),
  );
  return selectedSourceIds.map((sourceId) => {
    const source = sourceById.get(sourceId);
    const current = Boolean(
      source &&
      source.permission === "campus_indexer_allowed" &&
      !source.deletedAt &&
      source.documentVersionId &&
      source.activeVersionId === source.documentVersionId &&
      source.eligible &&
      !source.retiredAt,
    );
    if (!current || !source?.documentVersionId) {
      return {
        sourceId,
        documentVersionId: null,
        chunkCount: 0,
        embeddedChunkCount: 0,
        status: "blocked" as const,
      };
    }
    const count = countByVersion.get(source.documentVersionId) ?? {
      chunkCount: 0,
      embeddedChunkCount: 0,
    };
    const status =
      count.embeddedChunkCount === 0
        ? "not_indexed"
        : count.embeddedChunkCount >= count.chunkCount
          ? "ready"
          : "partial";
    return {
      sourceId,
      documentVersionId: source.documentVersionId,
      ...count,
      status,
    };
  });
}
