-- Auditable, worker-mediated publication state for manually authored revisions.

DO $$ BEGIN CREATE TYPE compendium_editor_publication_action AS ENUM ('publish', 'unpublish');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE compendium_editor_publication_status AS ENUM ('pending', 'queued', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE compendium_revisions ADD COLUMN IF NOT EXISTS based_on_revision_id uuid;
ALTER TABLE compendium_revisions ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE compendium_revisions ADD COLUMN IF NOT EXISTS change_reason text;

ALTER TABLE compendium_revisions DROP CONSTRAINT IF EXISTS compendium_revisions_editor_metadata;
ALTER TABLE compendium_revisions ADD CONSTRAINT compendium_revisions_editor_metadata CHECK (
  (created_by IS NULL AND change_reason IS NULL)
  OR (btrim(created_by) <> '' AND btrim(change_reason) <> '')
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'compendium_revisions'::regclass AND conname = 'compendium_revisions_based_on_fk') THEN
    ALTER TABLE compendium_revisions ADD CONSTRAINT compendium_revisions_based_on_fk
      FOREIGN KEY (based_on_revision_id, version_id)
      REFERENCES compendium_revisions(id, version_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS compendium_editor_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES compendium_versions(id),
  revision_id uuid,
  action compendium_editor_publication_action NOT NULL,
  status compendium_editor_publication_status NOT NULL DEFAULT 'pending',
  idempotency_key text NOT NULL UNIQUE,
  expected_active_revision_id text,
  canonical_revision_id text,
  actor text NOT NULL,
  reason text NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT compendium_editor_publication_text CHECK (btrim(actor) <> '' AND btrim(reason) <> ''),
  CONSTRAINT compendium_editor_publication_revision_fk FOREIGN KEY (revision_id, version_id)
    REFERENCES compendium_revisions(id, version_id),
  CONSTRAINT compendium_editor_publication_key CHECK (idempotency_key ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$'),
  CONSTRAINT compendium_editor_expected_revision CHECK (expected_active_revision_id IS NULL OR expected_active_revision_id ~ '^rev-[0-9a-f]{64}$'),
  CONSTRAINT compendium_editor_canonical_revision CHECK (canonical_revision_id IS NULL OR canonical_revision_id ~ '^rev-[0-9a-f]{64}$'),
  CONSTRAINT compendium_editor_publication_shape CHECK (
    (action = 'publish' AND revision_id IS NOT NULL AND canonical_revision_id IS NOT NULL)
    OR (action = 'unpublish' AND revision_id IS NULL AND canonical_revision_id IS NULL)
  ),
  CONSTRAINT compendium_editor_publication_outcome CHECK (
    (status IN ('pending', 'queued') AND last_error IS NULL AND completed_at IS NULL)
    OR (status = 'completed' AND last_error IS NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND last_error IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS compendium_editor_one_open_publication_idx
  ON compendium_editor_publications(version_id) WHERE status IN ('pending', 'queued');
CREATE INDEX IF NOT EXISTS compendium_editor_publications_history_idx
  ON compendium_editor_publications(version_id, created_at DESC);

CREATE TABLE IF NOT EXISTS compendium_editor_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES compendium_versions(id),
  revision_id uuid,
  event_type text NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_editor_audit_text CHECK (
    btrim(event_type) <> '' AND btrim(actor) <> '' AND btrim(reason) <> ''
  ),
  CONSTRAINT compendium_editor_audit_details CHECK (jsonb_typeof(details) = 'object')
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'compendium_editor_audit'::regclass AND conname = 'compendium_editor_audit_revision_fk') THEN
    ALTER TABLE compendium_editor_audit ADD CONSTRAINT compendium_editor_audit_revision_fk
      FOREIGN KEY (revision_id, version_id) REFERENCES compendium_revisions(id, version_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS compendium_editor_audit_history_idx
  ON compendium_editor_audit(version_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION compendium_guard_editor_publication_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.version_id IS DISTINCT FROM NEW.version_id
     OR OLD.revision_id IS DISTINCT FROM NEW.revision_id
     OR OLD.action IS DISTINCT FROM NEW.action
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.expected_active_revision_id IS DISTINCT FROM NEW.expected_active_revision_id
     OR OLD.canonical_revision_id IS DISTINCT FROM NEW.canonical_revision_id
     OR OLD.actor IS DISTINCT FROM NEW.actor OR OLD.reason IS DISTINCT FROM NEW.reason
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'compendium editor publication commands are immutable';
  END IF;
  IF NOT (OLD.status = 'pending' AND NEW.status = 'queued'
      OR OLD.status IN ('pending', 'queued') AND NEW.status IN ('completed', 'failed')) THEN
    RAISE EXCEPTION 'invalid compendium editor publication transition';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_editor_publications_immutable ON compendium_editor_publications;
CREATE TRIGGER compendium_editor_publications_immutable BEFORE UPDATE OR DELETE ON compendium_editor_publications
FOR EACH ROW EXECUTE FUNCTION compendium_guard_editor_publication_immutability();

CREATE OR REPLACE FUNCTION compendium_guard_editor_audit_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'compendium editor audit records are immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_editor_audit_immutable ON compendium_editor_audit;
CREATE TRIGGER compendium_editor_audit_immutable BEFORE UPDATE OR DELETE ON compendium_editor_audit
FOR EACH ROW EXECUTE FUNCTION compendium_guard_editor_audit_immutability();

CREATE OR REPLACE FUNCTION compendium_guard_editor_revision_metadata() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by IS NULL OR btrim(NEW.created_by) = '' OR NEW.change_reason IS NULL OR btrim(NEW.change_reason) = '' THEN
    RAISE EXCEPTION 'editor revisions require actor and reason';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_editor_revision_metadata_required ON compendium_revisions;
CREATE TRIGGER compendium_editor_revision_metadata_required BEFORE INSERT ON compendium_revisions
FOR EACH ROW WHEN (NEW.created_by IS NOT NULL OR NEW.change_reason IS NOT NULL)
EXECUTE FUNCTION compendium_guard_editor_revision_metadata();
