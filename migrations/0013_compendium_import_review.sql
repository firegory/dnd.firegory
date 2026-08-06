-- Admin review state for immutable import candidates. Canonical content is not
-- written here; approved intents are delivered through the worker-only spool.

DO $$ BEGIN CREATE TYPE compendium_review_decision AS ENUM (
  'pending', 'approved', 'rejected', 'merged', 'unpublish'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE compendium_review_publication_status AS ENUM (
  'idle', 'pending', 'queued', 'completed', 'failed'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS compendium_import_candidate_reviews (
  candidate_id uuid PRIMARY KEY REFERENCES compendium_import_candidates(id),
  import_run_id uuid NOT NULL REFERENCES compendium_import_runs(id),
  decision compendium_review_decision NOT NULL DEFAULT 'pending',
  resolved_content jsonb,
  publication_status compendium_review_publication_status NOT NULL DEFAULT 'idle',
  publication_attempt integer NOT NULL DEFAULT 0,
  idempotency_key text,
  last_error text,
  reviewed_by text,
  reviewed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_review_candidate_run_unique UNIQUE (candidate_id, import_run_id),
  CONSTRAINT compendium_review_resolved_content_object CHECK (
    resolved_content IS NULL OR jsonb_typeof(resolved_content) = 'object'
  ),
  CONSTRAINT compendium_review_attempt_nonnegative CHECK (publication_attempt >= 0),
  CONSTRAINT compendium_review_decision_shape CHECK (
    (decision = 'pending' AND resolved_content IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (decision = 'approved' AND resolved_content IS NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    OR (decision = 'rejected' AND resolved_content IS NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    OR (decision = 'merged' AND resolved_content IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    OR (decision = 'unpublish' AND resolved_content IS NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT compendium_review_publication_shape CHECK (
    (publication_status = 'idle' AND idempotency_key IS NULL AND publication_attempt = 0 AND last_error IS NULL)
    OR (publication_status IN ('pending', 'queued', 'completed') AND idempotency_key IS NOT NULL AND publication_attempt > 0 AND last_error IS NULL)
    OR (publication_status = 'failed' AND idempotency_key IS NOT NULL AND publication_attempt > 0 AND last_error IS NOT NULL)
  ),
  CONSTRAINT compendium_review_idempotency_key_format CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$'
  ),
  CONSTRAINT compendium_review_publishable_decision CHECK (
    publication_status = 'idle' OR decision IN ('approved', 'merged', 'unpublish')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS compendium_import_review_idempotency_idx
  ON compendium_import_candidate_reviews(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS compendium_import_review_run_decision_idx
  ON compendium_import_candidate_reviews(import_run_id, decision, publication_status);

CREATE TABLE IF NOT EXISTS compendium_import_review_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_run_id uuid NOT NULL REFERENCES compendium_import_runs(id),
  candidate_id uuid REFERENCES compendium_import_candidates(id),
  event_type text NOT NULL,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_import_review_audit_text CHECK (btrim(event_type) <> '' AND btrim(actor) <> ''),
  CONSTRAINT compendium_import_review_audit_details CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX IF NOT EXISTS compendium_import_review_audit_run_created_idx
  ON compendium_import_review_audit(import_run_id, created_at, id);

CREATE OR REPLACE FUNCTION compendium_validate_candidate_review() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE candidate_run uuid;
DECLARE run_status compendium_import_status;
BEGIN
  SELECT candidate.import_run_id, run.status INTO candidate_run, run_status
  FROM compendium_import_candidates candidate
  JOIN compendium_import_runs run ON run.id = candidate.import_run_id
  WHERE candidate.id = NEW.candidate_id
  FOR SHARE OF candidate, run;
  IF candidate_run IS NULL OR candidate_run <> NEW.import_run_id THEN
    RAISE EXCEPTION 'candidate review must remain inside its import run';
  END IF;
  IF NEW.decision <> 'pending' AND run_status <> 'succeeded' THEN
    RAISE EXCEPTION 'only successful import runs may be reviewed';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.publication_status = 'completed'
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed candidate publication state is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_candidate_review_valid ON compendium_import_candidate_reviews;
CREATE TRIGGER compendium_candidate_review_valid BEFORE INSERT OR UPDATE
ON compendium_import_candidate_reviews FOR EACH ROW EXECUTE FUNCTION compendium_validate_candidate_review();

CREATE OR REPLACE FUNCTION compendium_guard_review_audit_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'candidate review audit records are immutable'; END IF;
  IF NEW.candidate_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM compendium_import_candidates candidate
    WHERE candidate.id = NEW.candidate_id AND candidate.import_run_id = NEW.import_run_id
  ) THEN
    RAISE EXCEPTION 'candidate review audit must remain inside its import run';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_review_audit_immutable ON compendium_import_review_audit;
CREATE TRIGGER compendium_review_audit_immutable BEFORE INSERT OR UPDATE OR DELETE
ON compendium_import_review_audit FOR EACH ROW EXECUTE FUNCTION compendium_guard_review_audit_immutability();
