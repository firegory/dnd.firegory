ALTER TABLE compendium_import_runs
  ADD COLUMN IF NOT EXISTS allowed_review_entry_types text[];

DO $$ BEGIN
  ALTER TABLE compendium_import_runs
    ADD CONSTRAINT compendium_import_run_review_scope_nonempty CHECK (
      allowed_review_entry_types IS NULL
      OR (cardinality(allowed_review_entry_types) > 0
        AND array_position(allowed_review_entry_types, NULL) IS NULL
        AND allowed_review_entry_types <@ ARRAY[
          'spell', 'creature', 'item', 'class', 'feature', 'species', 'background',
          'feat', 'equipment', 'glossary', 'guide'
        ]::text[])
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
