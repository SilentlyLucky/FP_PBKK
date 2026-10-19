import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
const vector768 = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(768)",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => {
    const normalized = value.trim();
    if (!normalized.startsWith("[") || !normalized.endsWith("]")) {
      throw new Error("PostgreSQL returned a malformed pgvector value");
    }
    const body = normalized.slice(1, -1);
    return body.length === 0 ? [] : body.split(",").map(Number);
  },
});
const now = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow();

export const providerId = pgEnum("provider_id", [
  "campus_gateway",
  "codex_app_server",
  "claude_cli",
  "fixture",
]);

export const runPurpose = pgEnum("run_purpose", [
  "optimizer",
  "target",
  "evaluator",
  "auxiliary",
  "graph_indexing",
  "graph_query_model",
]);

export const runStatus = pgEnum("run_status", [
  "created",
  "queued",
  "running",
  "cancel_requested",
  "paused_quota",
  "paused_auth_required",
  "succeeded",
  "failed",
  "canceled",
  "interrupted_unknown",
]);

export const graphAssertionStatus = pgEnum("graph_assertion_status", [
  "extracted_supported",
  "needs_review",
  "rejected",
]);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull().default("local"),
    name: varchar("name", { length: 120 }).notNull(),
    objective: text("objective"),
    retentionPolicy: jsonb("retention_policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: now(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("projects_owner_name_active_uq")
      .on(table.ownerId, table.name)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: providerId("provider").notNull(),
    role: varchar("role", { length: 24 }).notNull(),
    authKind: varchar("auth_kind", { length: 80 }).notNull(),
    secretRef: varchar("secret_ref", { length: 240 }),
    endpointLabel: varchar("endpoint_label", { length: 240 }),
    requestedModel: varchar("requested_model", { length: 200 }),
    responseModel: varchar("response_model", { length: 200 }),
    connectionStatus: varchar("connection_status", { length: 32 })
      .notNull()
      .default("unavailable"),
    capabilitySnapshot: jsonb("capability_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    checkedAt: timestamp("checked_at", { withTimezone: true, mode: "date" }),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("provider_connections_project_id_uq").on(table.projectId, table.id),
    index("provider_connections_project_provider_idx").on(
      table.projectId,
      table.provider,
    ),
  ],
);

export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    currentVersionId: uuid("current_version_id"),
    createdAt: now(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    unique("prompts_project_id_uq").on(table.projectId, table.id),
    index("prompts_project_updated_idx").on(table.projectId, table.updatedAt),
    foreignKey({
      name: "prompts_current_version_fk",
      columns: [table.projectId, table.id, table.currentVersionId],
      foreignColumns: promptVersionTargetColumns(),
    }),
  ],
);

function promptVersionTargetColumns(): [AnyPgColumn, AnyPgColumn, AnyPgColumn] {
  return [promptVersions.projectId, promptVersions.promptId, promptVersions.id];
}

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    promptId: uuid("prompt_id").notNull(),
    version: integer("version").notNull(),
    parentVersionId: uuid("parent_version_id"),
    text: text("text").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    invariantDefinition: jsonb("invariant_definition")
      .$type<string[]>()
      .notNull()
      .default([]),
    invariantHash: varchar("invariant_hash", { length: 64 }).notNull(),
    rendererVersion: varchar("renderer_version", { length: 80 })
      .notNull()
      .default("promptlab-renderer-v1"),
    createdBy: text("created_by").notNull().default("local"),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "prompt_versions_project_prompt_fk",
      columns: [table.projectId, table.promptId],
      foreignColumns: [prompts.projectId, prompts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "prompt_versions_parent_fk",
      columns: [table.projectId, table.promptId, table.parentVersionId],
      foreignColumns: [table.projectId, table.promptId, table.id],
    }),
    unique("prompt_versions_project_id_uq").on(table.projectId, table.id),
    unique("prompt_versions_project_prompt_id_uq").on(
      table.projectId,
      table.promptId,
      table.id,
    ),
    unique("prompt_versions_project_prompt_version_uq").on(
      table.projectId,
      table.promptId,
      table.version,
    ),
    check("prompt_versions_positive_version_ck", sql`${table.version} > 0`),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 240 }).notNull(),
    sourceKind: varchar("source_kind", { length: 40 }).notNull(),
    trust: varchar("trust", { length: 32 }).notNull().default("unreviewed"),
    activeVersionId: uuid("active_version_id"),
    createdAt: now(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    foreignKey({
      name: "documents_active_version_fk",
      columns: [table.projectId, table.id, table.activeVersionId],
      foreignColumns: documentVersionTargetColumns(),
    }),
    unique("documents_project_id_uq").on(table.projectId, table.id),
    index("documents_project_updated_idx").on(table.projectId, table.updatedAt),
  ],
);

function documentVersionTargetColumns(): [
  AnyPgColumn,
  AnyPgColumn,
  AnyPgColumn,
] {
  return [
    documentVersions.projectId,
    documentVersions.documentId,
    documentVersions.id,
  ];
}

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull(),
    version: integer("version").notNull(),
    sourceRef: varchar("source_ref", { length: 500 }),
    sourceMetadata: jsonb("source_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    checksum: varchar("checksum", { length: 64 }).notNull(),
    rawByteSha256: varchar("raw_byte_sha256", { length: 64 }),
    rawByteSize: bigint("raw_byte_size", { mode: "number" }),
    contentType: varchar("content_type", { length: 120 }).notNull(),
    eligible: boolean("eligible").notNull().default(true),
    extractStatus: varchar("extract_status", { length: 32 })
      .notNull()
      .default("pending"),
    wordCount: integer("word_count"),
    createdAt: now(),
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    foreignKey({
      name: "document_versions_project_document_fk",
      columns: [table.projectId, table.documentId],
      foreignColumns: [documents.projectId, documents.id],
    }).onDelete("cascade"),
    unique("document_versions_project_id_uq").on(table.projectId, table.id),
    unique("document_versions_project_document_id_uq").on(
      table.projectId,
      table.documentId,
      table.id,
    ),
    unique("document_versions_document_version_uq").on(
      table.documentId,
      table.version,
    ),
    check("document_versions_positive_version_ck", sql`${table.version} > 0`),
    check(
      "document_versions_raw_bytes_pair_ck",
      sql`(${table.rawByteSha256} is null) = (${table.rawByteSize} is null)`,
    ),
    check(
      "document_versions_raw_byte_sha256_ck",
      sql`${table.rawByteSha256} is null or ${table.rawByteSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "document_versions_raw_byte_size_ck",
      sql`${table.rawByteSize} is null or ${table.rawByteSize} >= 0`,
    ),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    searchVector: tsvector("search_vector"),
    pageNumber: integer("page_number"),
    heading: varchar("heading", { length: 500 }),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    tokenEstimate: integer("token_estimate"),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "chunks_project_version_fk",
      columns: [table.projectId, table.documentVersionId],
      foreignColumns: [documentVersions.projectId, documentVersions.id],
    }).onDelete("cascade"),
    unique("chunks_project_id_uq").on(table.projectId, table.id),
    unique("chunks_project_version_id_uq").on(
      table.projectId,
      table.documentVersionId,
      table.id,
    ),
    unique("chunks_version_ordinal_uq").on(
      table.documentVersionId,
      table.ordinal,
    ),
    index("chunks_project_version_idx").on(
      table.projectId,
      table.documentVersionId,
    ),
    check("chunks_nonnegative_ordinal_ck", sql`${table.ordinal} >= 0`),
  ],
);

export const knowledgeEmbeddingProfiles = pgTable(
  "knowledge_embedding_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 80 }).notNull(),
    requestedModel: varchar("requested_model", { length: 200 }).notNull(),
    observedModel: varchar("observed_model", { length: 200 }).notNull(),
    modelDigest: varchar("model_digest", { length: 200 }),
    dimensions: integer("dimensions").notNull(),
    chunkingVersion: varchar("chunking_version", { length: 120 }).notNull(),
    preprocessingVersion: varchar("preprocessing_version", {
      length: 120,
    }).notNull(),
    queryTemplateVersion: varchar("query_template_version", {
      length: 120,
    }).notNull(),
    documentTemplateVersion: varchar("document_template_version", {
      length: 120,
    }).notNull(),
    profileChecksum: varchar("profile_checksum", { length: 64 }).notNull(),
    createdAt: now(),
  },
  (table) => [
    unique("knowledge_embedding_profiles_project_checksum_uq").on(
      table.projectId,
      table.profileChecksum,
    ),
    unique("knowledge_embedding_profiles_project_id_checksum_uq").on(
      table.projectId,
      table.id,
      table.profileChecksum,
    ),
    check(
      "knowledge_embedding_profiles_768_dimensions_ck",
      sql`${table.dimensions} = 768`,
    ),
    check(
      "knowledge_embedding_profiles_checksum_ck",
      sql`${table.profileChecksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "knowledge_embedding_profiles_required_fields_ck",
      sql`length(btrim(${table.provider})) > 0 and length(btrim(${table.requestedModel})) > 0 and length(btrim(${table.observedModel})) > 0 and length(btrim(${table.chunkingVersion})) > 0 and length(btrim(${table.preprocessingVersion})) > 0 and length(btrim(${table.queryTemplateVersion})) > 0 and length(btrim(${table.documentTemplateVersion})) > 0`,
    ),
  ],
);

export const knowledgeChunkEmbeddings = pgTable(
  "knowledge_chunk_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    documentVersionId: uuid("document_version_id").notNull(),
    chunkId: uuid("chunk_id").notNull(),
    profileId: uuid("profile_id").notNull(),
    profileChecksum: varchar("profile_checksum", { length: 64 }).notNull(),
    chunkChecksum: varchar("chunk_checksum", { length: 64 }).notNull(),
    embedding: vector768("embedding").notNull(),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "knowledge_chunk_embeddings_chunk_fk",
      columns: [table.projectId, table.documentVersionId, table.chunkId],
      foreignColumns: [chunks.projectId, chunks.documentVersionId, chunks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_chunk_embeddings_profile_fk",
      columns: [table.projectId, table.profileId, table.profileChecksum],
      foreignColumns: [
        knowledgeEmbeddingProfiles.projectId,
        knowledgeEmbeddingProfiles.id,
        knowledgeEmbeddingProfiles.profileChecksum,
      ],
    }).onDelete("cascade"),
    unique("knowledge_chunk_embeddings_exact_source_profile_uq").on(
      table.projectId,
      table.documentVersionId,
      table.chunkId,
      table.profileId,
      table.profileChecksum,
      table.chunkChecksum,
    ),
    index("knowledge_chunk_embeddings_lookup_idx").on(
      table.projectId,
      table.profileId,
      table.documentVersionId,
    ),
    check(
      "knowledge_chunk_embeddings_profile_checksum_ck",
      sql`${table.profileChecksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "knowledge_chunk_embeddings_chunk_checksum_ck",
      sql`${table.chunkChecksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "knowledge_chunk_embeddings_nonzero_vector_ck",
      sql`vector_norm(${table.embedding}) > 0`,
    ),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    promptVersionId: uuid("prompt_version_id"),
    providerConnectionId: uuid("provider_connection_id"),
    parentRunId: uuid("parent_run_id"),
    purpose: runPurpose("purpose").notNull(),
    provider: providerId("provider").notNull(),
    requestedModel: varchar("requested_model", { length: 200 }).notNull(),
    responseModel: varchar("response_model", { length: 200 }),
    status: runStatus("status").notNull().default("created"),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    configSnapshot: jsonb("config_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    promptTemplateHash: varchar("prompt_template_hash", { length: 64 }),
    schemaVersion: varchar("schema_version", { length: 80 }),
    errorCode: varchar("error_code", { length: 80 }),
    errorSummary: varchar("error_summary", { length: 500 }),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      withTimezone: true,
      mode: "date",
    }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "runs_project_prompt_version_fk",
      columns: [table.projectId, table.promptVersionId],
      foreignColumns: [promptVersions.projectId, promptVersions.id],
    }),
    foreignKey({
      name: "runs_project_provider_connection_fk",
      columns: [table.projectId, table.providerConnectionId],
      foreignColumns: [providerConnections.projectId, providerConnections.id],
    }),
    foreignKey({
      name: "runs_project_parent_run_fk",
      columns: [table.projectId, table.parentRunId],
      foreignColumns: [table.projectId, table.id],
    }),
    unique("runs_project_id_uq").on(table.projectId, table.id),
    unique("runs_project_idempotency_uq").on(
      table.projectId,
      table.idempotencyKey,
    ),
    index("runs_project_created_idx").on(table.projectId, table.createdAt),
    check(
      "runs_idempotency_key_length_ck",
      sql`length(${table.idempotencyKey}) >= 8`,
    ),
  ],
);

export const modelAttempts = pgTable(
  "model_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    provider: providerId("provider").notNull(),
    purpose: runPurpose("purpose").notNull(),
    requestedModel: varchar("requested_model", { length: 200 }).notNull(),
    responseModel: varchar("response_model", { length: 200 }),
    providerResponseId: varchar("provider_response_id", { length: 300 }),
    status: varchar("status", { length: 32 }).notNull().default("created"),
    remoteOutcomeKnown: boolean("remote_outcome_known")
      .notNull()
      .default(false),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    errorCode: varchar("error_code", { length: 80 }),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "model_attempts_project_run_fk",
      columns: [table.projectId, table.runId],
      foreignColumns: [runs.projectId, runs.id],
    }).onDelete("cascade"),
    unique("model_attempts_project_id_uq").on(table.projectId, table.id),
    unique("model_attempts_project_run_id_uq").on(
      table.projectId,
      table.runId,
      table.id,
    ),
    unique("model_attempts_run_number_uq").on(table.runId, table.attemptNumber),
    uniqueIndex("model_attempts_provider_response_uq")
      .on(table.provider, table.providerResponseId)
      .where(sql`${table.providerResponseId} is not null`),
    check("model_attempts_positive_number_ck", sql`${table.attemptNumber} > 0`),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: varchar("event_type", { length: 40 }).notNull(),
    attemptId: uuid("attempt_id"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "run_events_project_run_fk",
      columns: [table.projectId, table.runId],
      foreignColumns: [runs.projectId, runs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "run_events_project_attempt_fk",
      columns: [table.projectId, table.runId, table.attemptId],
      foreignColumns: [
        modelAttempts.projectId,
        modelAttempts.runId,
        modelAttempts.id,
      ],
    }),
    unique("run_events_run_sequence_uq").on(table.runId, table.sequence),
    index("run_events_project_run_created_idx").on(
      table.projectId,
      table.runId,
      table.createdAt,
    ),
    check("run_events_positive_sequence_ck", sql`${table.sequence} > 0`),
  ],
);

export const workspaceConversations = pgTable(
  "workspace_conversations",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 120 }).notNull(),
    conversation: jsonb("conversation")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("workspace_conversations_project_id_uq").on(
      table.projectId,
      table.id,
    ),
    index("workspace_conversations_project_updated_idx").on(
      table.projectId,
      table.updatedAt,
    ),
  ],
);

export const monitoringEventCounters = pgTable(
  "monitoring_event_counters",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    lastOrdinal: bigint("last_ordinal", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
  },
  (table) => [
    check(
      "monitoring_event_counters_nonnegative_ck",
      sql`${table.lastOrdinal} >= 0`,
    ),
  ],
);

export const monitoringEventOutbox = pgTable(
  "monitoring_event_outbox",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ordinal: bigint("ordinal", { mode: "bigint" }).notNull(),
    eventId: uuid("event_id").notNull(),
  },
  // No run_events FK: keep cursor metadata after event retention for gap detection.
  (table) => [
    primaryKey({
      name: "monitoring_event_outbox_pk",
      columns: [table.projectId, table.ordinal],
    }),
    unique("monitoring_event_outbox_project_event_uq").on(
      table.projectId,
      table.eventId,
    ),
    check(
      "monitoring_event_outbox_positive_ordinal_ck",
      sql`${table.ordinal} > 0`,
    ),
  ],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    attemptId: uuid("attempt_id"),
    provider: providerId("provider").notNull(),
    purpose: runPurpose("purpose").notNull(),
    providerResponseId: varchar("provider_response_id", { length: 300 }),
    usageScope: varchar("usage_scope", { length: 40 })
      .notNull()
      .default("response"),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    provenance: varchar("provenance", { length: 16 }).notNull(),
    completeness: varchar("completeness", { length: 16 }).notNull(),
    mapperVersion: varchar("mapper_version", { length: 80 }).notNull(),
    sanitizedRawUsage: jsonb("sanitized_raw_usage").$type<
      Record<string, unknown>
    >(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "date" }),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "usage_records_project_run_fk",
      columns: [table.projectId, table.runId],
      foreignColumns: [runs.projectId, runs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "usage_records_project_attempt_fk",
      columns: [table.projectId, table.runId, table.attemptId],
      foreignColumns: [
        modelAttempts.projectId,
        modelAttempts.runId,
        modelAttempts.id,
      ],
    }),
    uniqueIndex("usage_records_response_scope_uq")
      .on(table.provider, table.providerResponseId, table.usageScope)
      .where(sql`${table.providerResponseId} is not null`),
    index("usage_records_project_run_purpose_idx").on(
      table.projectId,
      table.runId,
      table.purpose,
    ),
    check(
      "usage_records_provenance_ck",
      sql`${table.provenance} in ('reported', 'estimated', 'unknown')`,
    ),
    check(
      "usage_records_completeness_ck",
      sql`${table.completeness} in ('complete', 'partial', 'unknown')`,
    ),
    check(
      "usage_records_nonnegative_tokens_ck",
      sql`
      (${table.inputTokens} is null or ${table.inputTokens} >= 0) and
      (${table.outputTokens} is null or ${table.outputTokens} >= 0) and
      (${table.cacheReadTokens} is null or ${table.cacheReadTokens} >= 0) and
      (${table.cacheWriteTokens} is null or ${table.cacheWriteTokens} >= 0)
    `,
    ),
    check(
      "usage_records_usage_scope_ck",
      sql`${table.usageScope} in ('response', 'run', 'session', 'aggregate')`,
    ),
  ],
);

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: varchar("event_type", { length: 80 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: now(),
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    unique("outbox_project_id_uq").on(table.projectId, table.id),
    index("outbox_pending_created_idx").on(table.state, table.createdAt),
    check("outbox_nonnegative_attempts_ck", sql`${table.attempts} >= 0`),
  ],
);

export const graphBuilds = pgTable(
  "graph_builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceManifest: jsonb("source_manifest")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    sourceManifestHash: varchar("source_manifest_hash", {
      length: 64,
    }).notNull(),
    extractorProvider: providerId("extractor_provider"),
    extractorModel: varchar("extractor_model", { length: 200 }),
    extractionPromptVersion: varchar("extraction_prompt_version", {
      length: 120,
    }).notNull(),
    extractionSchemaVersion: varchar("extraction_schema_version", {
      length: 120,
    }).notNull(),
    state: varchar("state", { length: 32 }).notNull().default("queued"),
    budget: jsonb("budget")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    usageRefs: jsonb("usage_refs").$type<string[]>().notNull().default([]),
    requestedAt: now(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    unique("graph_builds_project_id_uq").on(table.projectId, table.id),
    index("graph_builds_project_requested_idx").on(
      table.projectId,
      table.requestedAt,
    ),
  ],
);

export const graphSnapshots = pgTable(
  "graph_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    buildId: uuid("build_id").notNull(),
    sourceManifest: jsonb("source_manifest")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    sourceManifestHash: varchar("source_manifest_hash", {
      length: 64,
    }).notNull(),
    coverage: jsonb("coverage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    state: varchar("state", { length: 24 }).notNull().default("staging"),
    activatedAt: timestamp("activated_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "graph_snapshots_project_build_fk",
      columns: [table.projectId, table.buildId],
      foreignColumns: [graphBuilds.projectId, graphBuilds.id],
    }),
    unique("graph_snapshots_project_id_uq").on(table.projectId, table.id),
    index("graph_snapshots_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

export const graphEntities = pgTable(
  "graph_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    canonicalLabel: varchar("canonical_label", { length: 500 }).notNull(),
    entityType: varchar("entity_type", { length: 80 }).notNull(),
    normalizedLabel: varchar("normalized_label", { length: 500 }).notNull(),
    aliases: text("aliases").array().notNull().default([]),
    reviewStatus: varchar("review_status", { length: 24 })
      .notNull()
      .default("unreviewed"),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("graph_entities_project_id_uq").on(table.projectId, table.id),
    index("graph_entities_project_normalized_idx").on(
      table.projectId,
      table.normalizedLabel,
    ),
    index("graph_entities_project_type_idx").on(
      table.projectId,
      table.entityType,
    ),
  ],
);

export const graphMentions = pgTable(
  "graph_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").notNull(),
    documentVersionId: uuid("document_version_id").notNull(),
    chunkId: uuid("chunk_id").notNull(),
    spanStart: integer("span_start").notNull(),
    spanEnd: integer("span_end").notNull(),
    surfaceText: varchar("surface_text", { length: 500 }).notNull(),
    extractionRunId: uuid("extraction_run_id"),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "graph_mentions_project_entity_fk",
      columns: [table.projectId, table.entityId],
      foreignColumns: [graphEntities.projectId, graphEntities.id],
    }),
    foreignKey({
      name: "graph_mentions_project_version_chunk_fk",
      columns: [table.projectId, table.documentVersionId, table.chunkId],
      foreignColumns: [chunks.projectId, chunks.documentVersionId, chunks.id],
    }),
    foreignKey({
      name: "graph_mentions_project_extraction_run_fk",
      columns: [table.projectId, table.extractionRunId],
      foreignColumns: [runs.projectId, runs.id],
    }),
    unique("graph_mentions_project_id_uq").on(table.projectId, table.id),
    index("graph_mentions_chunk_idx").on(table.projectId, table.chunkId),
    check(
      "graph_mentions_valid_span_ck",
      sql`${table.spanStart} >= 0 and ${table.spanEnd} > ${table.spanStart}`,
    ),
  ],
);

export const graphAssertions = pgTable(
  "graph_assertions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    subjectEntityId: uuid("subject_entity_id").notNull(),
    predicate: varchar("predicate", { length: 120 }).notNull(),
    objectEntityId: uuid("object_entity_id").notNull(),
    direction: varchar("direction", { length: 16 })
      .notNull()
      .default("directed"),
    qualifiers: jsonb("qualifiers")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: graphAssertionStatus("status").notNull().default("needs_review"),
    currentVersion: integer("current_version").notNull().default(1),
    createdAt: now(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "graph_assertions_project_subject_fk",
      columns: [table.projectId, table.subjectEntityId],
      foreignColumns: [graphEntities.projectId, graphEntities.id],
    }),
    foreignKey({
      name: "graph_assertions_project_object_fk",
      columns: [table.projectId, table.objectEntityId],
      foreignColumns: [graphEntities.projectId, graphEntities.id],
    }),
    unique("graph_assertions_project_id_uq").on(table.projectId, table.id),
    index("graph_assertions_subject_predicate_idx").on(
      table.projectId,
      table.subjectEntityId,
      table.predicate,
    ),
    index("graph_assertions_object_predicate_idx").on(
      table.projectId,
      table.objectEntityId,
      table.predicate,
    ),
    check(
      "graph_assertions_positive_version_ck",
      sql`${table.currentVersion} > 0`,
    ),
  ],
);

export const graphAssertionVersions = pgTable(
  "graph_assertion_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    assertionId: uuid("assertion_id").notNull(),
    version: integer("version").notNull(),
    subjectEntityId: uuid("subject_entity_id").notNull(),
    predicate: varchar("predicate", { length: 120 }).notNull(),
    objectEntityId: uuid("object_entity_id").notNull(),
    direction: varchar("direction", { length: 16 }).notNull(),
    qualifiers: jsonb("qualifiers")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: graphAssertionStatus("status").notNull(),
    changedBy: text("changed_by").notNull().default("extractor"),
    changeReason: varchar("change_reason", { length: 500 }),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "graph_assertion_versions_project_assertion_fk",
      columns: [table.projectId, table.assertionId],
      foreignColumns: [graphAssertions.projectId, graphAssertions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "graph_assertion_versions_project_subject_fk",
      columns: [table.projectId, table.subjectEntityId],
      foreignColumns: [graphEntities.projectId, graphEntities.id],
    }),
    foreignKey({
      name: "graph_assertion_versions_project_object_fk",
      columns: [table.projectId, table.objectEntityId],
      foreignColumns: [graphEntities.projectId, graphEntities.id],
    }),
    unique("graph_assertion_versions_project_id_uq").on(
      table.projectId,
      table.id,
    ),
    unique("graph_assertion_versions_project_assertion_id_uq").on(
      table.projectId,
      table.assertionId,
      table.id,
    ),
    unique("graph_assertion_versions_number_uq").on(
      table.assertionId,
      table.version,
    ),
  ],
);

export const graphEvidence = pgTable(
  "graph_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    assertionId: uuid("assertion_id").notNull(),
    assertionVersionId: uuid("assertion_version_id").notNull(),
    documentVersionId: uuid("document_version_id").notNull(),
    chunkId: uuid("chunk_id").notNull(),
    quote: text("quote").notNull(),
    spanStart: integer("span_start").notNull(),
    spanEnd: integer("span_end").notNull(),
    sourceChecksum: varchar("source_checksum", { length: 64 }).notNull(),
    extractionRunId: uuid("extraction_run_id"),
    eligible: boolean("eligible").notNull().default(true),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "graph_evidence_project_assertion_fk",
      columns: [table.projectId, table.assertionId],
      foreignColumns: [graphAssertions.projectId, graphAssertions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "graph_evidence_project_assertion_version_fk",
      columns: [table.projectId, table.assertionId, table.assertionVersionId],
      foreignColumns: [
        graphAssertionVersions.projectId,
        graphAssertionVersions.assertionId,
        graphAssertionVersions.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "graph_evidence_project_version_chunk_fk",
      columns: [table.projectId, table.documentVersionId, table.chunkId],
      foreignColumns: [chunks.projectId, chunks.documentVersionId, chunks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "graph_evidence_project_extraction_run_fk",
      columns: [table.projectId, table.extractionRunId],
      foreignColumns: [runs.projectId, runs.id],
    }),
    unique("graph_evidence_project_id_uq").on(table.projectId, table.id),
    index("graph_evidence_assertion_eligible_idx").on(
      table.projectId,
      table.assertionId,
      table.eligible,
    ),
    index("graph_evidence_source_version_idx").on(
      table.projectId,
      table.documentVersionId,
    ),
    check(
      "graph_evidence_valid_span_ck",
      sql`${table.spanStart} >= 0 and ${table.spanEnd} > ${table.spanStart}`,
    ),
  ],
);

export const graphSnapshotAssertions = pgTable(
  "graph_snapshot_assertions",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id").notNull(),
    assertionId: uuid("assertion_id").notNull(),
    assertionVersionId: uuid("assertion_version_id").notNull(),
    sourceManifestHash: varchar("source_manifest_hash", {
      length: 64,
    }).notNull(),
    eligible: boolean("eligible").notNull().default(true),
    createdAt: now(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.projectId,
        table.snapshotId,
        table.assertionId,
        table.assertionVersionId,
      ],
    }),
    foreignKey({
      name: "graph_snapshot_assertions_project_snapshot_fk",
      columns: [table.projectId, table.snapshotId],
      foreignColumns: [graphSnapshots.projectId, graphSnapshots.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "graph_snapshot_assertions_project_assertion_version_fk",
      columns: [table.projectId, table.assertionId, table.assertionVersionId],
      foreignColumns: [
        graphAssertionVersions.projectId,
        graphAssertionVersions.assertionId,
        graphAssertionVersions.id,
      ],
    }).onDelete("cascade"),
    index("graph_snapshot_assertions_active_query_idx").on(
      table.projectId,
      table.snapshotId,
      table.eligible,
    ),
  ],
);

export const graphActiveSnapshots = pgTable(
  "graph_active_snapshots",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "graph_active_snapshots_project_snapshot_fk",
      columns: [table.projectId, table.snapshotId],
      foreignColumns: [graphSnapshots.projectId, graphSnapshots.id],
    }),
    check(
      "graph_active_snapshots_positive_revision_ck",
      sql`${table.revision} > 0`,
    ),
  ],
);

export const graphQueryTraces = pgTable(
  "graph_query_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    snapshotId: uuid("snapshot_id"),
    seeds: jsonb("seeds").$type<string[]>().notNull().default([]),
    selectedPaths: jsonb("selected_paths")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default([]),
    bounds: jsonb("bounds").$type<Record<string, unknown>>().notNull(),
    fallbackReason: varchar("fallback_reason", { length: 500 }),
    clipping: jsonb("clipping")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    estimatedContextTokens: integer("estimated_context_tokens"),
    elapsedMs: integer("elapsed_ms"),
    createdAt: now(),
  },
  (table) => [
    foreignKey({
      name: "graph_query_traces_project_run_fk",
      columns: [table.projectId, table.runId],
      foreignColumns: [runs.projectId, runs.id],
    }),
    foreignKey({
      name: "graph_query_traces_project_snapshot_fk",
      columns: [table.projectId, table.snapshotId],
      foreignColumns: [graphSnapshots.projectId, graphSnapshots.id],
    }),
    index("graph_query_traces_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

export const schema = {
  projects,
  providerConnections,
  prompts,
  promptVersions,
  documents,
  documentVersions,
  chunks,
  runs,
  modelAttempts,
  runEvents,
  workspaceConversations,
  usageRecords,
  outbox,
  graphBuilds,
  graphSnapshots,
  graphEntities,
  graphMentions,
  graphAssertions,
  graphAssertionVersions,
  graphEvidence,
  graphSnapshotAssertions,
  graphActiveSnapshots,
  graphQueryTraces,
};
