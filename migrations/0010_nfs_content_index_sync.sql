-- Resumable NFS content index synchronization. These tables are an ownership
-- boundary: the synchronizer may retire only content registered here.

DO $$ BEGIN CREATE TYPE nfs_index_sync_mode AS ENUM ('clean', 'incremental');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE nfs_index_sync_status AS ENUM ('staging', 'applying', 'succeeded', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE nfs_index_entry_lifecycle AS ENUM ('active', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS nfs_index_sync_runs (
  id uuid PRIMARY KEY,
  repository_id text NOT NULL,
  mode nfs_index_sync_mode NOT NULL,
  manifest_hash text NOT NULL,
  repository_generation text,
  status nfs_index_sync_status NOT NULL DEFAULT 'staging',
  planned_additions integer NOT NULL,
  planned_updates integer NOT NULL,
  planned_removals integer NOT NULL,
  staged_entries integer NOT NULL DEFAULT 0,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (btrim(repository_id) <> ''),
  CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (repository_generation IS NULL OR repository_generation ~ '^[0-9]{32}$'),
  CHECK (planned_additions >= 0 AND planned_updates >= 0 AND planned_removals >= 0),
  CHECK (staged_entries >= 0),
  CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS nfs_index_sync_runs_resume_idx
  ON nfs_index_sync_runs(repository_id, manifest_hash, mode, created_at DESC)
  WHERE status IN ('staging', 'failed');

CREATE TABLE IF NOT EXISTS nfs_index_sync_staging (
  run_id uuid NOT NULL REFERENCES nfs_index_sync_runs(id) ON DELETE CASCADE,
  entry_id text NOT NULL,
  ordinal integer NOT NULL,
  revision_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (run_id, entry_id),
  UNIQUE (run_id, ordinal),
  CHECK (btrim(entry_id) <> ''),
  CHECK (ordinal >= 0),
  CHECK (revision_id ~ '^rev-[0-9a-f]{64}$'),
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS nfs_index_managed_sources (
  source_id uuid PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  repository_id text NOT NULL,
  canonical_source_id text NOT NULL,
  UNIQUE (repository_id, canonical_source_id)
);

CREATE TABLE IF NOT EXISTS nfs_index_managed_files (
  file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES nfs_index_managed_sources(source_id) ON DELETE CASCADE,
  repository_id text NOT NULL,
  canonical_file_id text NOT NULL,
  UNIQUE (repository_id, source_id, canonical_file_id)
);

CREATE TABLE IF NOT EXISTS nfs_index_entries (
  id uuid PRIMARY KEY,
  repository_id text NOT NULL,
  entry_id text NOT NULL,
  revision_id text NOT NULL,
  content_hash text NOT NULL,
  entry_type text NOT NULL,
  name text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  typed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  plain_text text NOT NULL,
  canonical_payload jsonb NOT NULL,
  source_id uuid NOT NULL REFERENCES nfs_index_managed_sources(source_id),
  file_id uuid NOT NULL REFERENCES nfs_index_managed_files(file_id),
  generation_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES documents(id),
  lifecycle nfs_index_entry_lifecycle NOT NULL DEFAULT 'active',
  indexed_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (repository_id, entry_id),
  CHECK (revision_id ~ '^rev-[0-9a-f]{64}$'),
  CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (btrim(entry_type) <> '' AND btrim(name) <> '' AND btrim(plain_text) <> ''),
  CHECK (jsonb_typeof(aliases) = 'array' AND jsonb_typeof(typed_fields) = 'array'),
  CHECK (jsonb_typeof(canonical_payload) = 'object'),
  CHECK ((lifecycle = 'active' AND retired_at IS NULL) OR (lifecycle = 'retired' AND retired_at IS NOT NULL)),
  FOREIGN KEY (generation_id, file_id, source_id)
    REFERENCES ingestion_generations(id, file_id, source_id)
);
CREATE INDEX IF NOT EXISTS nfs_index_entries_active_idx
  ON nfs_index_entries(repository_id, entry_id) WHERE lifecycle = 'active';
