-- Spell browse fields required by the reviewed canonical vertical slice.
-- Existing spell revisions remain valid and receive an empty class list.

ALTER TABLE compendium_spells
  ADD COLUMN IF NOT EXISTS classes text[] NOT NULL DEFAULT ARRAY[]::text[];

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compendium_spells_classes_valid') THEN
    ALTER TABLE compendium_spells ADD CONSTRAINT compendium_spells_classes_valid CHECK (
      array_position(classes, NULL) IS NULL
      AND array_position(classes, '') IS NULL
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS compendium_spells_classes_idx
  ON compendium_spells USING gin (classes);

CREATE INDEX IF NOT EXISTS compendium_spells_filters_idx
  ON compendium_spells (level, school, ritual, concentration, revision_id);

-- Collector occurrences retain the immutable raw resource identity separately
-- from reviewable candidate JSON.
ALTER TABLE compendium_import_occurrences
  ADD COLUMN IF NOT EXISTS raw_blob_path text,
  ADD COLUMN IF NOT EXISTS source_fetched_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compendium_import_occurrences_raw_evidence') THEN
    ALTER TABLE compendium_import_occurrences ADD CONSTRAINT compendium_import_occurrences_raw_evidence CHECK (
      (raw_blob_path IS NULL AND source_fetched_at IS NULL)
      OR (raw_blob_path ~ '^blobs/[0-9a-f]{64}\.html$' AND source_fetched_at IS NOT NULL)
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION compendium_guard_occurrence_external_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.locator, NEW.fingerprint_sha256, NEW.raw_blob_path, NEW.source_fetched_at,
      NEW.source_id, NEW.file_id, NEW.import_run_id, NEW.occurrence_index)
     IS DISTINCT FROM
     (OLD.locator, OLD.fingerprint_sha256, OLD.raw_blob_path, OLD.source_fetched_at,
      OLD.source_id, OLD.file_id, OLD.import_run_id, OLD.occurrence_index) THEN
    RAISE EXCEPTION 'import occurrence external evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_occurrence_external_evidence_immutable ON compendium_import_occurrences;
CREATE TRIGGER compendium_occurrence_external_evidence_immutable BEFORE UPDATE ON compendium_import_occurrences
FOR EACH ROW EXECUTE FUNCTION compendium_guard_occurrence_external_evidence();
