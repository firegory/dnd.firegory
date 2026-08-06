-- Durable import orchestration and immutable review candidates. This extends
-- the run and occurrence tables created by 0007; it does not publish content.

DO $$ BEGIN CREATE TYPE compendium_import_diff_status AS ENUM (
  'new', 'unchanged', 'changed', 'missing', 'duplicate', 'invalid'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE compendium_import_diagnostic_level AS ENUM ('info', 'warning', 'error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE compendium_import_runs
  ADD COLUMN IF NOT EXISTS parser_version text,
  ADD COLUMN IF NOT EXISTS prompt_version text,
  ADD COLUMN IF NOT EXISTS model_version text,
  ADD COLUMN IF NOT EXISTS input_sha256 text,
  ADD COLUMN IF NOT EXISTS checkpoint text NOT NULL DEFAULT 'created',
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS occurrence_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS candidate_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS diagnostic_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS new_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unchanged_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS changed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS missing_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duplicate_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invalid_count integer NOT NULL DEFAULT 0;

-- Preserve any pre-0008 run rows with explicit legacy version metadata and a
-- stable identity hash. New application writes always supply real versions.
UPDATE compendium_import_runs
SET parser_version = coalesce(parser_version, importer_version),
    prompt_version = coalesce(prompt_version, 'none'),
    model_version = coalesce(model_version, 'none'),
    input_sha256 = coalesce(input_sha256, encode(digest(
      concat_ws(':', id::text, source_id::text, file_id::text, coalesce(generation_id::text, ''), importer, importer_version),
      'sha256'
    ), 'hex'))
WHERE parser_version IS NULL OR prompt_version IS NULL OR model_version IS NULL OR input_sha256 IS NULL;

-- 0007 already allowed terminal runs. Normalize those rows before adding the
-- success/checkpoint constraint, and retain any completed occurrence phase.
UPDATE compendium_import_runs run
SET checkpoint = CASE
  WHEN run.status = 'succeeded' THEN 'completed'
  WHEN run.status = 'failed' AND EXISTS (
    SELECT 1 FROM compendium_import_occurrences occurrence
    WHERE occurrence.import_run_id = run.id
  ) THEN 'occurrences'
  WHEN run.status = 'failed' THEN 'created'
  WHEN EXISTS (
    SELECT 1 FROM compendium_import_occurrences occurrence
    WHERE occurrence.import_run_id = run.id
  ) THEN 'occurrences'
  ELSE 'created'
END,
occurrence_count = (
  SELECT count(*)::integer FROM compendium_import_occurrences occurrence
  WHERE occurrence.import_run_id = run.id
);

ALTER TABLE compendium_import_runs
  ALTER COLUMN parser_version SET NOT NULL,
  ALTER COLUMN prompt_version SET NOT NULL,
  ALTER COLUMN model_version SET NOT NULL,
  ALTER COLUMN input_sha256 SET NOT NULL;

ALTER TABLE compendium_import_runs
  ADD CONSTRAINT compendium_import_runs_versions_not_blank CHECK (
    btrim(parser_version) <> '' AND btrim(prompt_version) <> '' AND btrim(model_version) <> ''
  ),
  ADD CONSTRAINT compendium_import_runs_input_hash CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT compendium_import_runs_checkpoint_valid CHECK (
    checkpoint IN ('created', 'occurrences', 'diffed', 'completed')
  ),
  ADD CONSTRAINT compendium_import_runs_lease_consistent CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  ADD CONSTRAINT compendium_import_runs_counters_nonnegative CHECK (
    occurrence_count >= 0 AND candidate_count >= 0 AND diagnostic_count >= 0
    AND new_count >= 0 AND unchanged_count >= 0 AND changed_count >= 0
    AND missing_count >= 0 AND duplicate_count >= 0 AND invalid_count >= 0
  ),
  ADD CONSTRAINT compendium_import_runs_success_checkpoint CHECK (
    status <> 'succeeded' OR checkpoint = 'completed'
  ),
  ADD CONSTRAINT compendium_import_runs_identity_unique UNIQUE NULLS NOT DISTINCT
    (source_id, file_id, generation_id, importer, importer_version, parser_version,
     prompt_version, model_version, input_sha256);

CREATE INDEX IF NOT EXISTS compendium_import_runs_resume_idx
  ON compendium_import_runs(status, lease_expires_at)
  WHERE status IN ('pending', 'running', 'failed');

CREATE OR REPLACE FUNCTION compendium_validate_import_run_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM files file
    WHERE file.id = NEW.file_id AND file.source_id = NEW.source_id
  ) OR (NEW.generation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ingestion_generations generation
    WHERE generation.id = NEW.generation_id AND generation.file_id = NEW.file_id
      AND generation.source_id = NEW.source_id
      AND (NEW.ingestion_job_id IS NULL OR generation.ingestion_job_id = NEW.ingestion_job_id)
  )) OR (NEW.ingestion_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ingestion_jobs job
    WHERE job.id = NEW.ingestion_job_id AND job.file_id = NEW.file_id
      AND job.source_id = NEW.source_id
  )) THEN
    RAISE EXCEPTION 'import run file, generation, and job must share one source boundary';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_import_runs_owner ON compendium_import_runs;
CREATE TRIGGER compendium_import_runs_owner BEFORE INSERT OR UPDATE ON compendium_import_runs
FOR EACH ROW EXECUTE FUNCTION compendium_validate_import_run_ownership();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compendium_import_occurrences_candidate_owner_unique') THEN
    ALTER TABLE compendium_import_occurrences ADD CONSTRAINT compendium_import_occurrences_candidate_owner_unique
      UNIQUE NULLS NOT DISTINCT (id, import_run_id, source_id, file_id, generation_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS compendium_import_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_run_id uuid NOT NULL,
  source_id uuid NOT NULL,
  file_id uuid NOT NULL,
  generation_id uuid,
  occurrence_id uuid,
  previous_candidate_id uuid,
  candidate_order integer NOT NULL,
  candidate_key text NOT NULL,
  entry_type compendium_entry_type,
  diff_status compendium_import_diff_status NOT NULL,
  content jsonb NOT NULL,
  content_sha256 text NOT NULL,
  invalid_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_import_candidates_run_owner_fk
    FOREIGN KEY (import_run_id, source_id, file_id, generation_id)
    REFERENCES compendium_import_runs(id, source_id, file_id, generation_id),
  CONSTRAINT compendium_import_candidates_occurrence_owner_fk
    FOREIGN KEY (occurrence_id, import_run_id, source_id, file_id, generation_id)
    REFERENCES compendium_import_occurrences(id, import_run_id, source_id, file_id, generation_id),
  CONSTRAINT compendium_import_candidates_previous_owner_fk
    FOREIGN KEY (previous_candidate_id, source_id, file_id)
    REFERENCES compendium_import_candidates(id, source_id, file_id),
  CONSTRAINT compendium_import_candidates_content_object CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT compendium_import_candidates_content_hash CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT compendium_import_candidates_order_nonnegative CHECK (candidate_order >= 0),
  CONSTRAINT compendium_import_candidates_key_not_blank CHECK (btrim(candidate_key) <> ''),
  CONSTRAINT compendium_import_candidates_shape CHECK (
    (diff_status = 'missing' AND occurrence_id IS NULL AND previous_candidate_id IS NOT NULL
      AND entry_type IS NOT NULL AND invalid_reason IS NULL)
    OR (diff_status = 'invalid' AND occurrence_id IS NOT NULL AND invalid_reason IS NOT NULL
      AND btrim(invalid_reason) <> '')
    OR (diff_status IN ('new', 'duplicate') AND occurrence_id IS NOT NULL
      AND entry_type IS NOT NULL AND invalid_reason IS NULL)
    OR (diff_status IN ('unchanged', 'changed') AND occurrence_id IS NOT NULL
      AND previous_candidate_id IS NOT NULL AND entry_type IS NOT NULL AND invalid_reason IS NULL)
  ),
  CONSTRAINT compendium_import_candidates_slot_unique UNIQUE NULLS NOT DISTINCT
    (import_run_id, candidate_key, occurrence_id),
  CONSTRAINT compendium_import_candidates_order_unique UNIQUE (import_run_id, candidate_order),
  CONSTRAINT compendium_import_candidates_id_source_file_unique UNIQUE (id, source_id, file_id)
);
CREATE INDEX IF NOT EXISTS compendium_import_candidates_run_status_idx
  ON compendium_import_candidates(import_run_id, diff_status, candidate_key);
CREATE INDEX IF NOT EXISTS compendium_import_candidates_previous_idx
  ON compendium_import_candidates(previous_candidate_id) WHERE previous_candidate_id IS NOT NULL;

CREATE OR REPLACE FUNCTION compendium_validate_candidate_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_source uuid;
  run_file uuid;
  run_generation uuid;
BEGIN
  SELECT source_id, file_id, generation_id INTO run_source, run_file, run_generation
  FROM compendium_import_runs WHERE id = NEW.import_run_id FOR SHARE;
  IF NOT FOUND OR (run_source, run_file, run_generation)
      IS DISTINCT FROM (NEW.source_id, NEW.file_id, NEW.generation_id) THEN
    RAISE EXCEPTION 'import candidate source and generation must exactly match its run';
  END IF;
  IF NEW.occurrence_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM compendium_import_occurrences occurrence
    WHERE occurrence.id = NEW.occurrence_id AND occurrence.import_run_id = NEW.import_run_id
      AND occurrence.source_id = NEW.source_id AND occurrence.file_id = NEW.file_id
      AND occurrence.generation_id IS NOT DISTINCT FROM NEW.generation_id
  ) THEN
    RAISE EXCEPTION 'import candidate occurrence must belong to its exact run boundary';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_import_candidates_owner ON compendium_import_candidates;
CREATE TRIGGER compendium_import_candidates_owner BEFORE INSERT OR UPDATE ON compendium_import_candidates
FOR EACH ROW EXECUTE FUNCTION compendium_validate_candidate_ownership();

CREATE TABLE IF NOT EXISTS compendium_import_checkpoints (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_run_id uuid NOT NULL REFERENCES compendium_import_runs(id),
  checkpoint_key text NOT NULL,
  content_sha256 text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_import_checkpoints_key_not_blank CHECK (btrim(checkpoint_key) <> ''),
  CONSTRAINT compendium_import_checkpoints_hash CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT compendium_import_checkpoints_details_object CHECK (jsonb_typeof(details) = 'object'),
  CONSTRAINT compendium_import_checkpoints_unique UNIQUE (import_run_id, checkpoint_key)
);

CREATE TABLE IF NOT EXISTS compendium_import_diagnostics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_run_id uuid NOT NULL REFERENCES compendium_import_runs(id),
  diagnostic_key text NOT NULL,
  level compendium_import_diagnostic_level NOT NULL,
  code text NOT NULL,
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_import_diagnostics_text_not_blank CHECK (
    btrim(diagnostic_key) <> '' AND btrim(code) <> '' AND btrim(message) <> ''
  ),
  CONSTRAINT compendium_import_diagnostics_details_object CHECK (jsonb_typeof(details) = 'object'),
  CONSTRAINT compendium_import_diagnostics_unique UNIQUE (import_run_id, diagnostic_key)
);
CREATE INDEX IF NOT EXISTS compendium_import_diagnostics_run_level_idx
  ON compendium_import_diagnostics(import_run_id, level, created_at);

CREATE TABLE IF NOT EXISTS compendium_import_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_run_id uuid NOT NULL REFERENCES compendium_import_runs(id),
  event_type text NOT NULL,
  from_status compendium_import_status,
  to_status compendium_import_status,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_import_audit_text_not_blank CHECK (btrim(event_type) <> '' AND btrim(actor) <> ''),
  CONSTRAINT compendium_import_audit_details_object CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX IF NOT EXISTS compendium_import_audit_run_created_idx
  ON compendium_import_audit(import_run_id, created_at, id);

CREATE OR REPLACE FUNCTION compendium_guard_import_run_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.source_id, NEW.file_id, NEW.generation_id, NEW.ingestion_job_id,
      NEW.importer, NEW.importer_version, NEW.parser_version, NEW.prompt_version,
      NEW.model_version, NEW.input_sha256)
     IS DISTINCT FROM
     (OLD.source_id, OLD.file_id, OLD.generation_id, OLD.ingestion_job_id,
      OLD.importer, OLD.importer_version, OLD.parser_version, OLD.prompt_version,
      OLD.model_version, OLD.input_sha256) THEN
    RAISE EXCEPTION 'import run ownership, input hash, and version metadata are immutable';
  END IF;
  IF OLD.status = 'succeeded' OR OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'completed import run state is immutable';
  END IF;
  IF NEW.checkpoint IS DISTINCT FROM OLD.checkpoint AND NOT (
    (OLD.checkpoint = 'created' AND NEW.checkpoint = 'occurrences')
    OR (OLD.checkpoint = 'occurrences' AND NEW.checkpoint = 'diffed')
    OR (OLD.checkpoint = 'diffed' AND NEW.checkpoint = 'completed')
  ) THEN
    RAISE EXCEPTION 'import run checkpoints must advance exactly one phase';
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('running', 'cancelled'))
    OR (OLD.status = 'running' AND NEW.status IN ('running', 'succeeded', 'failed', 'cancelled'))
    OR (OLD.status = 'failed' AND NEW.status = 'running')
  ) THEN
    RAISE EXCEPTION 'invalid import run transition from % to %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'running' AND NEW.started_at IS NULL THEN
    RAISE EXCEPTION 'running import runs require started_at';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_import_runs_lifecycle ON compendium_import_runs;
CREATE TRIGGER compendium_import_runs_lifecycle BEFORE UPDATE ON compendium_import_runs
FOR EACH ROW EXECUTE FUNCTION compendium_guard_import_run_lifecycle();

CREATE OR REPLACE FUNCTION compendium_guard_import_artifact_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_status compendium_import_status;
  run_checkpoint text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'import occurrences, candidates, checkpoints, diagnostics, and audit records are immutable';
  END IF;
  IF TG_TABLE_NAME IN ('compendium_import_occurrences', 'compendium_import_candidates', 'compendium_import_checkpoints', 'compendium_import_diagnostics') THEN
    SELECT status, checkpoint INTO run_status, run_checkpoint
    FROM compendium_import_runs WHERE id = NEW.import_run_id FOR SHARE;
    IF run_status <> 'running' THEN
      RAISE EXCEPTION 'import work may only be appended while its run is running';
    END IF;
    IF TG_TABLE_NAME = 'compendium_import_occurrences'
       AND run_checkpoint NOT IN ('created', 'occurrences') THEN
      RAISE EXCEPTION 'import occurrences cannot be appended after the occurrence phase';
    ELSIF TG_TABLE_NAME = 'compendium_import_candidates' AND run_checkpoint <> 'occurrences' THEN
      RAISE EXCEPTION 'import candidates may only be appended during the diff phase';
    ELSIF TG_TABLE_NAME = 'compendium_import_checkpoints' AND (
      (NEW.checkpoint_key LIKE 'occurrence:%' AND run_checkpoint NOT IN ('created', 'occurrences'))
      OR (NEW.checkpoint_key = 'candidate-diff' AND run_checkpoint <> 'occurrences')
      OR (NEW.checkpoint_key = 'completed' AND run_checkpoint <> 'diffed')
    ) THEN
      RAISE EXCEPTION 'import checkpoint does not match the current run phase';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'compendium_import_occurrences', 'compendium_import_candidates', 'compendium_import_checkpoints',
    'compendium_import_diagnostics', 'compendium_import_audit'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS compendium_import_artifact_immutable ON %I', table_name);
    EXECUTE format(
      'CREATE TRIGGER compendium_import_artifact_immutable BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION compendium_guard_import_artifact_immutability()',
      table_name
    );
  END LOOP;
END $$;

-- A revision with import provenance can only publish after every backing run
-- completed successfully. Missing/failed/partial review data stays isolated.
CREATE OR REPLACE FUNCTION compendium_require_successful_import_for_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
  FROM compendium_import_links link
  JOIN compendium_import_occurrences occurrence ON occurrence.id = link.occurrence_id
  JOIN compendium_import_runs run ON run.id = occurrence.import_run_id
  WHERE link.revision_id = NEW.id
  FOR SHARE OF link, occurrence, run;
  IF OLD.lifecycle = 'draft' AND NEW.lifecycle = 'published' AND EXISTS (
    SELECT 1
    FROM compendium_import_links link
    JOIN compendium_import_occurrences occurrence ON occurrence.id = link.occurrence_id
    JOIN compendium_import_runs run ON run.id = occurrence.import_run_id
    WHERE link.revision_id = NEW.id AND run.status <> 'succeeded'
  ) THEN
    RAISE EXCEPTION 'failed or partial import runs cannot publish revisions';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_revisions_import_succeeded ON compendium_revisions;
CREATE TRIGGER compendium_revisions_import_succeeded BEFORE UPDATE ON compendium_revisions
FOR EACH ROW EXECUTE FUNCTION compendium_require_successful_import_for_publication();

CREATE OR REPLACE FUNCTION compendium_guard_published_import_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_revision uuid;
  new_revision uuid;
  locked_revision uuid;
BEGIN
  old_revision := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.revision_id ELSE NULL END;
  new_revision := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.revision_id ELSE NULL END;
  FOR locked_revision IN
    SELECT DISTINCT revision_id
    FROM unnest(ARRAY[old_revision, new_revision]) AS revisions(revision_id)
    WHERE revision_id IS NOT NULL
    ORDER BY revision_id
  LOOP
    PERFORM 1 FROM compendium_revisions WHERE id = locked_revision FOR SHARE;
  END LOOP;

  IF new_revision IS NOT NULL AND EXISTS (
    SELECT 1
    FROM compendium_revisions revision
    JOIN compendium_import_occurrences occurrence ON occurrence.id = NEW.occurrence_id
    JOIN compendium_import_runs run ON run.id = occurrence.import_run_id
    WHERE revision.id = new_revision AND revision.lifecycle = 'published'
      AND run.status <> 'succeeded'
  ) THEN
    RAISE EXCEPTION 'published revisions cannot acquire failed or partial import provenance';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS compendium_import_links_published_run ON compendium_import_links;
CREATE TRIGGER compendium_import_links_published_run BEFORE INSERT OR UPDATE OR DELETE ON compendium_import_links
FOR EACH ROW EXECUTE FUNCTION compendium_guard_published_import_link();

-- Recheck at transaction end as well as immediately. This gives direct SQL
-- publication/link races a fresh post-lock invariant check under READ COMMITTED.
CREATE OR REPLACE FUNCTION compendium_validate_published_import_links() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_revision uuid;
BEGIN
  target_revision := CASE
    WHEN TG_TABLE_NAME = 'compendium_revisions' THEN NEW.id
    ELSE NEW.revision_id
  END;
  IF target_revision IS NOT NULL AND EXISTS (
    SELECT 1
    FROM compendium_revisions revision
    JOIN compendium_import_links link ON link.revision_id = revision.id
    JOIN compendium_import_occurrences occurrence ON occurrence.id = link.occurrence_id
    JOIN compendium_import_runs run ON run.id = occurrence.import_run_id
    WHERE revision.id = target_revision AND revision.lifecycle = 'published'
      AND run.status <> 'succeeded'
  ) THEN
    RAISE EXCEPTION 'published revisions require successful import provenance';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_revisions_import_links_valid ON compendium_revisions;
CREATE CONSTRAINT TRIGGER compendium_revisions_import_links_valid
AFTER UPDATE ON compendium_revisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION compendium_validate_published_import_links();
DROP TRIGGER IF EXISTS compendium_import_links_revision_valid ON compendium_import_links;
CREATE CONSTRAINT TRIGGER compendium_import_links_revision_valid
AFTER INSERT OR UPDATE ON compendium_import_links DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION compendium_validate_published_import_links();
