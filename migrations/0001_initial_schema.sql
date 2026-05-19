-- Initial MVP schema for dnd.firegory.
-- Requires PostgreSQL 16+ and pgvector (Compose uses pgvector/pgvector:pg16).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE user_role AS ENUM ('user', 'premium', 'admin');
CREATE TYPE source_category AS ENUM ('core_rules', 'official_supplement', 'homebrew');
CREATE TYPE source_edition AS ENUM ('5e', '5.5e');
CREATE TYPE source_language AS ENUM ('en', 'ru');
CREATE TYPE access_tier AS ENUM ('open', 'premium', 'personal');
CREATE TYPE ingestion_job_status AS ENUM ('queued', 'processing', 'succeeded', 'failed', 'cancelled');
CREATE TYPE ingestion_job_kind AS ENUM ('upload', 'cli', 'retry', 'reprocess');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'user',
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  disabled_at timestamptz,
  CONSTRAINT users_email_not_blank CHECK (btrim(email) <> ''),
  CONSTRAINT users_password_hash_not_blank CHECK (btrim(password_hash) <> '')
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT sessions_token_hash_not_blank CHECK (btrim(token_hash) <> '')
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category source_category NOT NULL,
  edition source_edition NOT NULL,
  language source_language NOT NULL,
  access_tier access_tier NOT NULL DEFAULT 'open',
  shared boolean NOT NULL DEFAULT false,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT sources_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT sources_open_not_owned CHECK (access_tier <> 'open' OR owner_user_id IS NULL),
  CONSTRAINT sources_premium_shared_pool CHECK (access_tier <> 'premium' OR (shared = true AND owner_user_id IS NULL)),
  CONSTRAINT sources_personal_owned CHECK (access_tier <> 'personal' OR (shared = false AND owner_user_id IS NOT NULL))
);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  checksum_sha256 text NOT NULL,
  byte_size bigint NOT NULL,
  storage_path text NOT NULL,
  processed_artifacts_root text,
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT files_original_filename_not_blank CHECK (btrim(original_filename) <> ''),
  CONSTRAINT files_mime_type_not_blank CHECK (btrim(mime_type) <> ''),
  CONSTRAINT files_checksum_sha256_format CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT files_byte_size_positive CHECK (byte_size > 0),
  CONSTRAINT files_storage_path_not_blank CHECK (btrim(storage_path) <> '')
);

CREATE TABLE ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind ingestion_job_kind NOT NULL DEFAULT 'upload',
  status ingestion_job_status NOT NULL DEFAULT 'queued',
  queue_id text UNIQUE,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress integer NOT NULL DEFAULT 0,
  error_summary text,
  log_path text,
  artifacts_root text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT ingestion_jobs_progress_range CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT ingestion_jobs_finished_status_consistency CHECK (
    (status IN ('succeeded', 'failed', 'cancelled') AND finished_at IS NOT NULL)
    OR (status NOT IN ('succeeded', 'failed', 'cancelled'))
  )
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ingestion_job_id uuid REFERENCES ingestion_jobs(id) ON DELETE SET NULL,
  title text,
  document_type text NOT NULL DEFAULT 'pdf',
  section_heading text,
  text text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_document_type_not_blank CHECK (btrim(document_type) <> '')
);

CREATE TABLE pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  ingestion_job_id uuid REFERENCES ingestion_jobs(id) ON DELETE SET NULL,
  page_number integer NOT NULL,
  section_heading text,
  text text NOT NULL DEFAULT '',
  text_span_start integer,
  text_span_end integer,
  bbox jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pages_page_number_positive CHECK (page_number > 0),
  CONSTRAINT pages_text_span_valid CHECK (
    (text_span_start IS NULL AND text_span_end IS NULL)
    OR (text_span_start IS NOT NULL AND text_span_end IS NOT NULL AND text_span_start >= 0 AND text_span_end >= text_span_start)
  ),
  UNIQUE (file_id, page_number)
);

CREATE TABLE chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  page_id uuid REFERENCES pages(id) ON DELETE SET NULL,
  ingestion_job_id uuid REFERENCES ingestion_jobs(id) ON DELETE SET NULL,
  chunk_index integer NOT NULL,
  text text NOT NULL,
  quote_text text NOT NULL,
  section_heading text,
  page_number integer,
  token_count integer,
  text_span_start integer,
  text_span_end integer,
  bbox jsonb,
  embedding vector(1024),
  embedding_model text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunks_chunk_index_nonnegative CHECK (chunk_index >= 0),
  CONSTRAINT chunks_text_not_blank CHECK (btrim(text) <> ''),
  CONSTRAINT chunks_quote_text_not_blank CHECK (btrim(quote_text) <> ''),
  CONSTRAINT chunks_page_number_positive CHECK (page_number IS NULL OR page_number > 0),
  CONSTRAINT chunks_token_count_positive CHECK (token_count IS NULL OR token_count > 0),
  CONSTRAINT chunks_text_span_valid CHECK (
    (text_span_start IS NULL AND text_span_end IS NULL)
    OR (text_span_start IS NOT NULL AND text_span_end IS NOT NULL AND text_span_start >= 0 AND text_span_end >= text_span_start)
  ),
  CONSTRAINT chunks_embedding_model_present CHECK (embedding IS NULL OR btrim(coalesce(embedding_model, '')) <> ''),
  UNIQUE (file_id, chunk_index)
);

CREATE TABLE search_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  query text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_chunk_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_events_query_not_blank CHECK (btrim(query) <> ''),
  CONSTRAINT search_events_latency_nonnegative CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

CREATE TABLE rag_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  search_event_id uuid REFERENCES search_events(id) ON DELETE SET NULL,
  query text NOT NULL,
  answer_language source_language NOT NULL,
  selected_chunk_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  provider text,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_events_query_not_blank CHECK (btrim(query) <> ''),
  CONSTRAINT rag_events_prompt_tokens_nonnegative CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  CONSTRAINT rag_events_completion_tokens_nonnegative CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  CONSTRAINT rag_events_latency_nonnegative CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

CREATE INDEX users_role_idx ON users(role);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE INDEX sources_access_idx ON sources(access_tier, shared, owner_user_id);
CREATE INDEX sources_corpus_idx ON sources(edition, language, category);
CREATE INDEX sources_deleted_at_idx ON sources(deleted_at);

CREATE INDEX files_source_id_idx ON files(source_id);
CREATE UNIQUE INDEX files_source_checksum_idx ON files(source_id, checksum_sha256) WHERE deleted_at IS NULL;

CREATE INDEX ingestion_jobs_status_idx ON ingestion_jobs(status, queued_at);
CREATE INDEX ingestion_jobs_source_id_idx ON ingestion_jobs(source_id);
CREATE INDEX ingestion_jobs_file_id_idx ON ingestion_jobs(file_id);

CREATE INDEX documents_source_id_idx ON documents(source_id);
CREATE INDEX documents_file_id_idx ON documents(file_id);
CREATE INDEX documents_text_search_idx ON documents USING gin (to_tsvector('simple', text));

CREATE INDEX pages_source_id_idx ON pages(source_id);
CREATE INDEX pages_file_id_idx ON pages(file_id);
CREATE INDEX pages_document_id_idx ON pages(document_id);
CREATE INDEX pages_text_search_idx ON pages USING gin (to_tsvector('simple', text));

CREATE INDEX chunks_source_id_idx ON chunks(source_id);
CREATE INDEX chunks_file_id_idx ON chunks(file_id);
CREATE INDEX chunks_document_id_idx ON chunks(document_id);
CREATE INDEX chunks_page_id_idx ON chunks(page_id);
CREATE INDEX chunks_text_search_idx ON chunks USING gin (to_tsvector('simple', text));
CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;

CREATE INDEX search_events_user_created_idx ON search_events(user_id, created_at DESC);
CREATE INDEX rag_events_user_created_idx ON rag_events(user_id, created_at DESC);
