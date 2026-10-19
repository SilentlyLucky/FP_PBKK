CREATE TYPE "public"."graph_assertion_status" AS ENUM('extracted_supported', 'needs_review', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."provider_id" AS ENUM('campus_gateway', 'codex_app_server', 'claude_cli', 'fixture');--> statement-breakpoint
CREATE TYPE "public"."run_purpose" AS ENUM('optimizer', 'target', 'evaluator', 'auxiliary', 'graph_indexing', 'graph_query_model');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('created', 'queued', 'running', 'cancel_requested', 'paused_quota', 'paused_auth_required', 'succeeded', 'failed', 'canceled', 'interrupted_unknown');--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"search_vector" "tsvector",
	"page_number" integer,
	"heading" varchar(500),
	"content_hash" varchar(64) NOT NULL,
	"token_estimate" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "chunks_project_version_id_uq" UNIQUE("project_id","document_version_id","id"),
	CONSTRAINT "chunks_version_ordinal_uq" UNIQUE("document_version_id","ordinal"),
	CONSTRAINT "chunks_nonnegative_ordinal_ck" CHECK ("chunks"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_ref" varchar(500),
	"checksum" varchar(64) NOT NULL,
	"content_type" varchar(120) NOT NULL,
	"eligible" boolean DEFAULT true NOT NULL,
	"extract_status" varchar(32) DEFAULT 'pending' NOT NULL,
	"word_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "document_versions_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "document_versions_project_document_id_uq" UNIQUE("project_id","document_id","id"),
	CONSTRAINT "document_versions_document_version_uq" UNIQUE("document_id","version"),
	CONSTRAINT "document_versions_positive_version_ck" CHECK ("document_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"display_name" varchar(240) NOT NULL,
	"source_kind" varchar(40) NOT NULL,
	"trust" varchar(32) DEFAULT 'unreviewed' NOT NULL,
	"active_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "documents_project_id_uq" UNIQUE("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "graph_active_snapshots" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_active_snapshots_positive_revision_ck" CHECK ("graph_active_snapshots"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "graph_assertion_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"assertion_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"subject_entity_id" uuid NOT NULL,
	"predicate" varchar(120) NOT NULL,
	"object_entity_id" uuid NOT NULL,
	"direction" varchar(16) NOT NULL,
	"qualifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "graph_assertion_status" NOT NULL,
	"changed_by" text DEFAULT 'extractor' NOT NULL,
	"change_reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_assertion_versions_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "graph_assertion_versions_project_assertion_id_uq" UNIQUE("project_id","assertion_id","id"),
	CONSTRAINT "graph_assertion_versions_number_uq" UNIQUE("assertion_id","version")
);
--> statement-breakpoint
CREATE TABLE "graph_assertions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"subject_entity_id" uuid NOT NULL,
	"predicate" varchar(120) NOT NULL,
	"object_entity_id" uuid NOT NULL,
	"direction" varchar(16) DEFAULT 'directed' NOT NULL,
	"qualifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "graph_assertion_status" DEFAULT 'needs_review' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_assertions_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "graph_assertions_positive_version_ck" CHECK ("graph_assertions"."current_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "graph_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_manifest" jsonb NOT NULL,
	"source_manifest_hash" varchar(64) NOT NULL,
	"extractor_provider" "provider_id",
	"extractor_model" varchar(200),
	"extraction_prompt_version" varchar(120) NOT NULL,
	"extraction_schema_version" varchar(120) NOT NULL,
	"state" varchar(32) DEFAULT 'queued' NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "graph_builds_project_id_uq" UNIQUE("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "graph_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"canonical_label" varchar(500) NOT NULL,
	"entity_type" varchar(80) NOT NULL,
	"normalized_label" varchar(500) NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"review_status" varchar(24) DEFAULT 'unreviewed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_entities_project_id_uq" UNIQUE("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "graph_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"assertion_id" uuid NOT NULL,
	"assertion_version_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"quote" text NOT NULL,
	"span_start" integer NOT NULL,
	"span_end" integer NOT NULL,
	"source_checksum" varchar(64) NOT NULL,
	"extraction_run_id" uuid,
	"eligible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_evidence_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "graph_evidence_valid_span_ck" CHECK ("graph_evidence"."span_start" >= 0 and "graph_evidence"."span_end" > "graph_evidence"."span_start")
);
--> statement-breakpoint
CREATE TABLE "graph_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"span_start" integer NOT NULL,
	"span_end" integer NOT NULL,
	"surface_text" varchar(500) NOT NULL,
	"extraction_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_mentions_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "graph_mentions_valid_span_ck" CHECK ("graph_mentions"."span_start" >= 0 and "graph_mentions"."span_end" > "graph_mentions"."span_start")
);
--> statement-breakpoint
CREATE TABLE "graph_query_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid,
	"snapshot_id" uuid,
	"seeds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bounds" jsonb NOT NULL,
	"fallback_reason" varchar(500),
	"clipping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"estimated_context_tokens" integer,
	"elapsed_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_snapshot_assertions" (
	"project_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"assertion_id" uuid NOT NULL,
	"assertion_version_id" uuid NOT NULL,
	"source_manifest_hash" varchar(64) NOT NULL,
	"eligible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_snapshot_assertions_project_id_snapshot_id_assertion_id_assertion_version_id_pk" PRIMARY KEY("project_id","snapshot_id","assertion_id","assertion_version_id")
);
--> statement-breakpoint
CREATE TABLE "graph_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"source_manifest" jsonb NOT NULL,
	"source_manifest_hash" varchar(64) NOT NULL,
	"coverage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" varchar(24) DEFAULT 'staging' NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_snapshots_project_id_uq" UNIQUE("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "model_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"provider" "provider_id" NOT NULL,
	"purpose" "run_purpose" NOT NULL,
	"requested_model" varchar(200) NOT NULL,
	"response_model" varchar(200),
	"provider_response_id" varchar(300),
	"status" varchar(32) DEFAULT 'created' NOT NULL,
	"remote_outcome_known" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_attempts_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "model_attempts_project_run_id_uq" UNIQUE("project_id","run_id","id"),
	CONSTRAINT "model_attempts_run_number_uq" UNIQUE("run_id","attempt_number"),
	CONSTRAINT "model_attempts_positive_number_ck" CHECK ("model_attempts"."attempt_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"payload" jsonb NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "outbox_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "outbox_nonnegative_attempts_ck" CHECK ("outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text DEFAULT 'local' NOT NULL,
	"name" varchar(120) NOT NULL,
	"objective" text,
	"retention_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"parent_version_id" uuid,
	"text" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"invariant_definition" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"invariant_hash" varchar(64) NOT NULL,
	"renderer_version" varchar(80) DEFAULT 'promptlab-renderer-v1' NOT NULL,
	"created_by" text DEFAULT 'local' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_versions_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "prompt_versions_project_prompt_id_uq" UNIQUE("project_id","prompt_id","id"),
	CONSTRAINT "prompt_versions_project_prompt_version_uq" UNIQUE("project_id","prompt_id","version"),
	CONSTRAINT "prompt_versions_positive_version_ck" CHECK ("prompt_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "prompts_project_id_uq" UNIQUE("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "provider_id" NOT NULL,
	"role" varchar(24) NOT NULL,
	"auth_kind" varchar(80) NOT NULL,
	"secret_ref" varchar(240),
	"endpoint_label" varchar(240),
	"requested_model" varchar(200),
	"response_model" varchar(200),
	"connection_status" varchar(32) DEFAULT 'unavailable' NOT NULL,
	"capability_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_connections_project_id_uq" UNIQUE("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"attempt_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_sequence_uq" UNIQUE("run_id","sequence"),
	CONSTRAINT "run_events_positive_sequence_ck" CHECK ("run_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"prompt_version_id" uuid,
	"provider_connection_id" uuid,
	"parent_run_id" uuid,
	"purpose" "run_purpose" NOT NULL,
	"provider" "provider_id" NOT NULL,
	"requested_model" varchar(200) NOT NULL,
	"response_model" varchar(200),
	"status" "run_status" DEFAULT 'created' NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"config_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_template_hash" varchar(64),
	"schema_version" varchar(80),
	"error_code" varchar(80),
	"error_summary" varchar(500),
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "runs_project_idempotency_uq" UNIQUE("project_id","idempotency_key"),
	CONSTRAINT "runs_idempotency_key_length_ck" CHECK (length("runs"."idempotency_key") >= 8)
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_id" uuid,
	"provider" "provider_id" NOT NULL,
	"purpose" "run_purpose" NOT NULL,
	"provider_response_id" varchar(300),
	"usage_scope" varchar(40) DEFAULT 'response' NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cache_read_tokens" bigint,
	"cache_write_tokens" bigint,
	"provenance" varchar(16) NOT NULL,
	"completeness" varchar(16) NOT NULL,
	"mapper_version" varchar(80) NOT NULL,
	"sanitized_raw_usage" jsonb,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_provenance_ck" CHECK ("usage_records"."provenance" in ('reported', 'estimated', 'unknown')),
	CONSTRAINT "usage_records_completeness_ck" CHECK ("usage_records"."completeness" in ('complete', 'partial', 'unknown')),
	CONSTRAINT "usage_records_nonnegative_tokens_ck" CHECK (
      ("usage_records"."input_tokens" is null or "usage_records"."input_tokens" >= 0) and
      ("usage_records"."output_tokens" is null or "usage_records"."output_tokens" >= 0) and
      ("usage_records"."cache_read_tokens" is null or "usage_records"."cache_read_tokens" >= 0) and
      ("usage_records"."cache_write_tokens" is null or "usage_records"."cache_write_tokens" >= 0)
    ),
	CONSTRAINT "usage_records_usage_scope_ck" CHECK ("usage_records"."usage_scope" in ('response', 'run', 'session', 'aggregate'))
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_project_version_fk" FOREIGN KEY ("project_id","document_version_id") REFERENCES "public"."document_versions"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_project_document_fk" FOREIGN KEY ("project_id","document_id") REFERENCES "public"."documents"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_active_version_fk" FOREIGN KEY ("project_id","id","active_version_id") REFERENCES "public"."document_versions"("project_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_active_snapshots" ADD CONSTRAINT "graph_active_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_active_snapshots" ADD CONSTRAINT "graph_active_snapshots_project_snapshot_fk" FOREIGN KEY ("project_id","snapshot_id") REFERENCES "public"."graph_snapshots"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_assertion_versions" ADD CONSTRAINT "graph_assertion_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_assertion_versions" ADD CONSTRAINT "graph_assertion_versions_project_assertion_fk" FOREIGN KEY ("project_id","assertion_id") REFERENCES "public"."graph_assertions"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_assertion_versions" ADD CONSTRAINT "graph_assertion_versions_project_subject_fk" FOREIGN KEY ("project_id","subject_entity_id") REFERENCES "public"."graph_entities"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_assertion_versions" ADD CONSTRAINT "graph_assertion_versions_project_object_fk" FOREIGN KEY ("project_id","object_entity_id") REFERENCES "public"."graph_entities"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_assertions" ADD CONSTRAINT "graph_assertions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_assertions" ADD CONSTRAINT "graph_assertions_project_subject_fk" FOREIGN KEY ("project_id","subject_entity_id") REFERENCES "public"."graph_entities"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_assertions" ADD CONSTRAINT "graph_assertions_project_object_fk" FOREIGN KEY ("project_id","object_entity_id") REFERENCES "public"."graph_entities"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_builds" ADD CONSTRAINT "graph_builds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_entities" ADD CONSTRAINT "graph_entities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_evidence" ADD CONSTRAINT "graph_evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_evidence" ADD CONSTRAINT "graph_evidence_project_assertion_fk" FOREIGN KEY ("project_id","assertion_id") REFERENCES "public"."graph_assertions"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_evidence" ADD CONSTRAINT "graph_evidence_project_assertion_version_fk" FOREIGN KEY ("project_id","assertion_id","assertion_version_id") REFERENCES "public"."graph_assertion_versions"("project_id","assertion_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_evidence" ADD CONSTRAINT "graph_evidence_project_version_chunk_fk" FOREIGN KEY ("project_id","document_version_id","chunk_id") REFERENCES "public"."chunks"("project_id","document_version_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_evidence" ADD CONSTRAINT "graph_evidence_project_extraction_run_fk" FOREIGN KEY ("project_id","extraction_run_id") REFERENCES "public"."runs"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_mentions" ADD CONSTRAINT "graph_mentions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_mentions" ADD CONSTRAINT "graph_mentions_project_entity_fk" FOREIGN KEY ("project_id","entity_id") REFERENCES "public"."graph_entities"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_mentions" ADD CONSTRAINT "graph_mentions_project_version_chunk_fk" FOREIGN KEY ("project_id","document_version_id","chunk_id") REFERENCES "public"."chunks"("project_id","document_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_mentions" ADD CONSTRAINT "graph_mentions_project_extraction_run_fk" FOREIGN KEY ("project_id","extraction_run_id") REFERENCES "public"."runs"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_query_traces" ADD CONSTRAINT "graph_query_traces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_query_traces" ADD CONSTRAINT "graph_query_traces_project_run_fk" FOREIGN KEY ("project_id","run_id") REFERENCES "public"."runs"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_query_traces" ADD CONSTRAINT "graph_query_traces_project_snapshot_fk" FOREIGN KEY ("project_id","snapshot_id") REFERENCES "public"."graph_snapshots"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_snapshot_assertions" ADD CONSTRAINT "graph_snapshot_assertions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_snapshot_assertions" ADD CONSTRAINT "graph_snapshot_assertions_project_snapshot_fk" FOREIGN KEY ("project_id","snapshot_id") REFERENCES "public"."graph_snapshots"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_snapshot_assertions" ADD CONSTRAINT "graph_snapshot_assertions_project_assertion_version_fk" FOREIGN KEY ("project_id","assertion_id","assertion_version_id") REFERENCES "public"."graph_assertion_versions"("project_id","assertion_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_project_build_fk" FOREIGN KEY ("project_id","build_id") REFERENCES "public"."graph_builds"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_attempts" ADD CONSTRAINT "model_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_attempts" ADD CONSTRAINT "model_attempts_project_run_fk" FOREIGN KEY ("project_id","run_id") REFERENCES "public"."runs"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_project_prompt_fk" FOREIGN KEY ("project_id","prompt_id") REFERENCES "public"."prompts"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_parent_fk" FOREIGN KEY ("project_id","prompt_id","parent_version_id") REFERENCES "public"."prompt_versions"("project_id","prompt_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_current_version_fk" FOREIGN KEY ("project_id","id","current_version_id") REFERENCES "public"."prompt_versions"("project_id","prompt_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_project_run_fk" FOREIGN KEY ("project_id","run_id") REFERENCES "public"."runs"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_project_attempt_fk" FOREIGN KEY ("project_id","run_id","attempt_id") REFERENCES "public"."model_attempts"("project_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_prompt_version_fk" FOREIGN KEY ("project_id","prompt_version_id") REFERENCES "public"."prompt_versions"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_provider_connection_fk" FOREIGN KEY ("project_id","provider_connection_id") REFERENCES "public"."provider_connections"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_parent_run_fk" FOREIGN KEY ("project_id","parent_run_id") REFERENCES "public"."runs"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_project_run_fk" FOREIGN KEY ("project_id","run_id") REFERENCES "public"."runs"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_project_attempt_fk" FOREIGN KEY ("project_id","run_id","attempt_id") REFERENCES "public"."model_attempts"("project_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_project_version_idx" ON "chunks" USING btree ("project_id","document_version_id");--> statement-breakpoint
CREATE INDEX "documents_project_updated_idx" ON "documents" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "graph_assertions_subject_predicate_idx" ON "graph_assertions" USING btree ("project_id","subject_entity_id","predicate");--> statement-breakpoint
CREATE INDEX "graph_assertions_object_predicate_idx" ON "graph_assertions" USING btree ("project_id","object_entity_id","predicate");--> statement-breakpoint
CREATE INDEX "graph_builds_project_requested_idx" ON "graph_builds" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "graph_entities_project_normalized_idx" ON "graph_entities" USING btree ("project_id","normalized_label");--> statement-breakpoint
CREATE INDEX "graph_entities_project_type_idx" ON "graph_entities" USING btree ("project_id","entity_type");--> statement-breakpoint
CREATE INDEX "graph_evidence_assertion_eligible_idx" ON "graph_evidence" USING btree ("project_id","assertion_id","eligible");--> statement-breakpoint
CREATE INDEX "graph_evidence_source_version_idx" ON "graph_evidence" USING btree ("project_id","document_version_id");--> statement-breakpoint
CREATE INDEX "graph_mentions_chunk_idx" ON "graph_mentions" USING btree ("project_id","chunk_id");--> statement-breakpoint
CREATE INDEX "graph_query_traces_project_created_idx" ON "graph_query_traces" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "graph_snapshot_assertions_active_query_idx" ON "graph_snapshot_assertions" USING btree ("project_id","snapshot_id","eligible");--> statement-breakpoint
CREATE INDEX "graph_snapshots_project_created_idx" ON "graph_snapshots" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_attempts_provider_response_uq" ON "model_attempts" USING btree ("provider","provider_response_id") WHERE "model_attempts"."provider_response_id" is not null;--> statement-breakpoint
CREATE INDEX "outbox_pending_created_idx" ON "outbox" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_owner_name_active_uq" ON "projects" USING btree ("owner_id","name") WHERE "projects"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "prompts_project_updated_idx" ON "prompts" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "provider_connections_project_provider_idx" ON "provider_connections" USING btree ("project_id","provider");--> statement-breakpoint
CREATE INDEX "run_events_project_run_created_idx" ON "run_events" USING btree ("project_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_project_created_idx" ON "runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_response_scope_uq" ON "usage_records" USING btree ("provider","provider_response_id","usage_scope") WHERE "usage_records"."provider_response_id" is not null;--> statement-breakpoint
CREATE INDEX "usage_records_project_run_purpose_idx" ON "usage_records" USING btree ("project_id","run_id","purpose");