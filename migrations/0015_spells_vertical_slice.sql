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
