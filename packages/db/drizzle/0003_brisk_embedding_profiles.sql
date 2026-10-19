CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
ALTER TABLE public.document_versions
	ADD COLUMN raw_byte_sha256 varchar(64),
	ADD COLUMN raw_byte_size bigint;
--> statement-breakpoint
ALTER TABLE public.document_versions
	ADD CONSTRAINT document_versions_raw_bytes_pair_ck
		CHECK ((raw_byte_sha256 IS NULL) = (raw_byte_size IS NULL)),
	ADD CONSTRAINT document_versions_raw_byte_sha256_ck
		CHECK (raw_byte_sha256 IS NULL OR raw_byte_sha256 ~ '^[0-9a-f]{64}$'),
	ADD CONSTRAINT document_versions_raw_byte_size_ck
		CHECK (raw_byte_size IS NULL OR raw_byte_size >= 0);
--> statement-breakpoint
CREATE TABLE public.knowledge_embedding_profiles (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	project_id uuid NOT NULL,
	provider varchar(80) NOT NULL,
	requested_model varchar(200) NOT NULL,
	observed_model varchar(200) NOT NULL,
	model_digest varchar(200),
	dimensions integer NOT NULL,
	chunking_version varchar(120) NOT NULL,
	preprocessing_version varchar(120) NOT NULL,
	query_template_version varchar(120) NOT NULL,
	document_template_version varchar(120) NOT NULL,
	profile_checksum varchar(64) NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT knowledge_embedding_profiles_project_checksum_uq UNIQUE(project_id, profile_checksum),
	CONSTRAINT knowledge_embedding_profiles_project_id_checksum_uq UNIQUE(project_id, id, profile_checksum),
	CONSTRAINT knowledge_embedding_profiles_project_fk FOREIGN KEY(project_id)
		REFERENCES public.projects(id) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT knowledge_embedding_profiles_768_dimensions_ck CHECK (dimensions = 768),
	CONSTRAINT knowledge_embedding_profiles_checksum_ck CHECK (profile_checksum ~ '^[0-9a-f]{64}$'),
	CONSTRAINT knowledge_embedding_profiles_required_fields_ck CHECK (
		length(btrim(provider)) > 0 AND
		length(btrim(requested_model)) > 0 AND
		length(btrim(observed_model)) > 0 AND
		length(btrim(chunking_version)) > 0 AND
		length(btrim(preprocessing_version)) > 0 AND
		length(btrim(query_template_version)) > 0 AND
		length(btrim(document_template_version)) > 0
	)
);
--> statement-breakpoint
CREATE TABLE public.knowledge_chunk_embeddings (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	project_id uuid NOT NULL,
	document_version_id uuid NOT NULL,
	chunk_id uuid NOT NULL,
	profile_id uuid NOT NULL,
	profile_checksum varchar(64) NOT NULL,
	chunk_checksum varchar(64) NOT NULL,
	embedding vector(768) NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT knowledge_chunk_embeddings_exact_source_profile_uq UNIQUE(
		project_id,
		document_version_id,
		chunk_id,
		profile_id,
		profile_checksum,
		chunk_checksum
	),
	CONSTRAINT knowledge_chunk_embeddings_chunk_fk FOREIGN KEY(project_id, document_version_id, chunk_id)
		REFERENCES public.chunks(project_id, document_version_id, id) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT knowledge_chunk_embeddings_profile_fk FOREIGN KEY(project_id, profile_id, profile_checksum)
		REFERENCES public.knowledge_embedding_profiles(project_id, id, profile_checksum) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT knowledge_chunk_embeddings_profile_checksum_ck CHECK (profile_checksum ~ '^[0-9a-f]{64}$'),
	CONSTRAINT knowledge_chunk_embeddings_chunk_checksum_ck CHECK (chunk_checksum ~ '^[0-9a-f]{64}$'),
	CONSTRAINT knowledge_chunk_embeddings_nonzero_vector_ck CHECK (vector_norm(embedding) > 0)
);
--> statement-breakpoint
CREATE INDEX knowledge_chunk_embeddings_lookup_idx
	ON public.knowledge_chunk_embeddings(project_id, profile_id, document_version_id);
