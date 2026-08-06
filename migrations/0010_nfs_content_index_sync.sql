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
  projection_hash text NOT NULL,
  projector_version integer NOT NULL,
  repository_generation text,
  status nfs_index_sync_status NOT NULL DEFAULT 'staging',
  owner_token uuid,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
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
  CHECK (projection_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (projector_version > 0),
  CHECK (repository_generation IS NULL OR repository_generation ~ '^[0-9]{32}$'),
  CHECK (planned_additions >= 0 AND planned_updates >= 0 AND planned_removals >= 0),
  CHECK (staged_entries >= 0),
  CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL))
);
ALTER TABLE nfs_index_sync_runs
  ADD COLUMN IF NOT EXISTS owner_token uuid,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nfs_index_sync_runs_inflight_lease') THEN
    ALTER TABLE nfs_index_sync_runs ADD CONSTRAINT nfs_index_sync_runs_inflight_lease CHECK (
      status NOT IN ('staging', 'applying')
      OR (owner_token IS NOT NULL AND heartbeat_at IS NOT NULL AND lease_expires_at > heartbeat_at)
    ) NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS nfs_index_sync_runs_resume_idx
  ON nfs_index_sync_runs(repository_id, projection_hash, mode, created_at DESC)
  WHERE status = 'staging';
CREATE UNIQUE INDEX IF NOT EXISTS nfs_index_sync_runs_one_inflight_repository_idx
  ON nfs_index_sync_runs(repository_id)
  WHERE status IN ('staging', 'applying');

CREATE OR REPLACE FUNCTION nfs_index_guard_sync_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'terminal NFS index sync status is immutable';
  END IF;
  IF OLD.status = 'applying' AND NEW.status NOT IN ('applying', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'NFS index sync status cannot move backwards from applying';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nfs_index_sync_status_monotonic ON nfs_index_sync_runs;
CREATE TRIGGER nfs_index_sync_status_monotonic
BEFORE UPDATE OF status ON nfs_index_sync_runs
FOR EACH ROW EXECUTE FUNCTION nfs_index_guard_sync_status();

CREATE OR REPLACE FUNCTION claim_nfs_index_sync_run(
  p_id uuid,
  p_repository_id text,
  p_mode nfs_index_sync_mode,
  p_projection_hash text,
  p_projector_version integer,
  p_repository_generation text,
  p_planned_additions integer,
  p_planned_updates integer,
  p_planned_removals integer,
  p_owner_token uuid,
  p_lease_seconds integer
) RETURNS TABLE (run_id uuid, resumed boolean)
LANGUAGE plpgsql AS $$
DECLARE
  active_run nfs_index_sync_runs%ROWTYPE;
  lease_now timestamptz := clock_timestamp();
BEGIN
  IF p_lease_seconds < 1 THEN RAISE EXCEPTION 'NFS index sync lease must be positive'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('nfs-index-claim:' || p_repository_id, 0));

  SELECT * INTO active_run FROM nfs_index_sync_runs
  WHERE repository_id = p_repository_id AND status IN ('staging', 'applying')
  FOR UPDATE;

  IF FOUND THEN
    IF active_run.owner_token = p_owner_token
       AND active_run.projection_hash = p_projection_hash
       AND active_run.mode = p_mode
       AND active_run.lease_expires_at > lease_now THEN
      UPDATE nfs_index_sync_runs
      SET heartbeat_at = lease_now,
          lease_expires_at = lease_now + make_interval(secs => p_lease_seconds),
          updated_at = lease_now
      WHERE id = active_run.id;
      RETURN QUERY SELECT active_run.id, true;
      RETURN;
    END IF;

    IF active_run.owner_token IS NOT NULL AND active_run.lease_expires_at > lease_now THEN
      RAISE EXCEPTION 'another live NFS index sync owner holds repository %', p_repository_id;
    END IF;

    IF active_run.status = 'staging'
       AND active_run.projection_hash = p_projection_hash
       AND active_run.mode = p_mode THEN
      UPDATE nfs_index_sync_runs
      SET owner_token = p_owner_token, heartbeat_at = lease_now,
          lease_expires_at = lease_now + make_interval(secs => p_lease_seconds),
          updated_at = lease_now
      WHERE id = active_run.id AND status = 'staging';
      RETURN QUERY SELECT active_run.id, true;
      RETURN;
    END IF;

    UPDATE nfs_index_sync_runs
    SET status = 'failed', error_summary = 'Superseded after sync owner lease expired',
        finished_at = lease_now, updated_at = lease_now
    WHERE id = active_run.id AND status IN ('staging', 'applying');
  END IF;

  INSERT INTO nfs_index_sync_runs
    (id, repository_id, mode, manifest_hash, projection_hash, projector_version,
     repository_generation, status, owner_token, heartbeat_at, lease_expires_at,
     planned_additions, planned_updates, planned_removals)
  VALUES
    (p_id, p_repository_id, p_mode, p_projection_hash, p_projection_hash, p_projector_version,
     p_repository_generation, 'staging', p_owner_token, lease_now,
     lease_now + make_interval(secs => p_lease_seconds),
     p_planned_additions, p_planned_updates, p_planned_removals);
  RETURN QUERY SELECT p_id, false;
END $$;

CREATE TABLE IF NOT EXISTS nfs_index_sync_staging (
  run_id uuid NOT NULL REFERENCES nfs_index_sync_runs(id) ON DELETE CASCADE,
  entry_id text NOT NULL,
  ordinal integer NOT NULL,
  revision_id text NOT NULL,
  projector_version integer NOT NULL,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (run_id, entry_id),
  UNIQUE (run_id, ordinal),
  CHECK (btrim(entry_id) <> ''),
  CHECK (ordinal >= 0),
  CHECK (revision_id ~ '^rev-[0-9a-f]{64}$'),
  CHECK (projector_version > 0),
  CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
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
