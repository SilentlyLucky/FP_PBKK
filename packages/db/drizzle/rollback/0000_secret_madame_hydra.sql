-- DESTRUCTIVE: removes the complete PromptLab foundation schema and migration journal.
-- Run only against an isolated local database after verifying the target and backup.
BEGIN;

-- Break the intentional prompt <-> current-version reference before dropping versions.
ALTER TABLE IF EXISTS public.prompts
  DROP CONSTRAINT IF EXISTS prompts_current_version_fk;
ALTER TABLE IF EXISTS public.documents
  DROP CONSTRAINT IF EXISTS documents_active_version_fk;

DROP TABLE IF EXISTS public.usage_records;
DROP TABLE IF EXISTS public.graph_evidence;
DROP TABLE IF EXISTS public.graph_snapshot_assertions;
DROP TABLE IF EXISTS public.graph_active_snapshots;
DROP TABLE IF EXISTS public.graph_query_traces;
DROP TABLE IF EXISTS public.graph_mentions;
DROP TABLE IF EXISTS public.graph_assertion_versions;
DROP TABLE IF EXISTS public.graph_assertions;
DROP TABLE IF EXISTS public.graph_snapshots;
DROP TABLE IF EXISTS public.graph_builds;
DROP TABLE IF EXISTS public.run_events;
DROP TABLE IF EXISTS public.model_attempts;
DROP TABLE IF EXISTS public.runs;
DROP TABLE IF EXISTS public.outbox;
DROP TABLE IF EXISTS public.chunks;
DROP TABLE IF EXISTS public.document_versions;
DROP TABLE IF EXISTS public.documents;
DROP TABLE IF EXISTS public.prompt_versions;
DROP TABLE IF EXISTS public.prompts;
DROP TABLE IF EXISTS public.provider_connections;
DROP TABLE IF EXISTS public.graph_entities;
DROP TABLE IF EXISTS public.projects;

DROP TYPE IF EXISTS public.run_status;
DROP TYPE IF EXISTS public.run_purpose;
DROP TYPE IF EXISTS public.provider_id;
DROP TYPE IF EXISTS public.graph_assertion_status;

DROP TABLE IF EXISTS drizzle.__drizzle_migrations;
DROP SCHEMA IF EXISTS drizzle;
COMMIT;
