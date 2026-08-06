-- Align durable candidate slots with the application identity. Entry type is
-- required because missing candidates share a NULL occurrence within a run.

ALTER TABLE compendium_import_candidates
  DROP CONSTRAINT IF EXISTS compendium_import_candidates_slot_unique;
DROP INDEX IF EXISTS compendium_import_candidates_slot_unique;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'compendium_import_candidates_identity_slot_unique'
      AND conrelid = 'compendium_import_candidates'::regclass
  ) THEN
    ALTER TABLE compendium_import_candidates
      ADD CONSTRAINT compendium_import_candidates_identity_slot_unique
      UNIQUE NULLS NOT DISTINCT (import_run_id, entry_type, candidate_key, occurrence_id);
  END IF;
END $$;
