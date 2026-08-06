-- Publication and canonical provenance projected from source.json.
-- Existing sources retain their display title as publication_title; fields that
-- cannot be inferred safely remain NULL. Priority defaults to the neutral 0.

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS canonical_source_id text,
  ADD COLUMN IF NOT EXISTS publication_code text,
  ADD COLUMN IF NOT EXISTS publication_title text,
  ADD COLUMN IF NOT EXISTS publisher text,
  ADD COLUMN IF NOT EXISTS release_year integer,
  ADD COLUMN IF NOT EXISTS publication_revision text,
  ADD COLUMN IF NOT EXISTS external_origin_url text,
  ADD COLUMN IF NOT EXISTS external_origin_id text,
  ADD COLUMN IF NOT EXISTS attribution text,
  ADD COLUMN IF NOT EXISTS source_priority integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS canonical_book_id text,
  ADD COLUMN IF NOT EXISTS license text;

UPDATE sources
SET publication_title = title
WHERE publication_title IS NULL;

ALTER TABLE sources
  ALTER COLUMN publication_title SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_canonical_source_id_format') THEN
    ALTER TABLE sources ADD CONSTRAINT sources_canonical_source_id_format
      CHECK (canonical_source_id IS NULL OR canonical_source_id ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_publication_text_not_blank') THEN
    ALTER TABLE sources ADD CONSTRAINT sources_publication_text_not_blank CHECK (
      btrim(publication_title) <> ''
      AND (publication_code IS NULL OR btrim(publication_code) <> '')
      AND (publisher IS NULL OR btrim(publisher) <> '')
      AND (publication_revision IS NULL OR btrim(publication_revision) <> '')
      AND (attribution IS NULL OR btrim(attribution) <> '')
      AND (canonical_book_id IS NULL OR btrim(canonical_book_id) <> '')
      AND (license IS NULL OR btrim(license) <> '')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_release_year_range') THEN
    ALTER TABLE sources ADD CONSTRAINT sources_release_year_range
      CHECK (release_year IS NULL OR release_year BETWEEN 1974 AND 2100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_revision_has_release_year') THEN
    ALTER TABLE sources ADD CONSTRAINT sources_revision_has_release_year
      CHECK (publication_revision IS NULL OR release_year IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_origin_complete') THEN
    ALTER TABLE sources ADD CONSTRAINT sources_origin_complete CHECK (
      (external_origin_url IS NULL AND external_origin_id IS NULL)
      OR (external_origin_url IS NOT NULL AND external_origin_id IS NOT NULL
          AND btrim(external_origin_url) <> '' AND btrim(external_origin_id) <> '')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_priority_range') THEN
    ALTER TABLE sources ADD CONSTRAINT sources_priority_range
      CHECK (source_priority BETWEEN 0 AND 1000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_canonical_book_id_format') THEN
    ALTER TABLE sources ADD CONSTRAINT sources_canonical_book_id_format
      CHECK (canonical_book_id IS NULL OR canonical_book_id ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_2024_edition_year') THEN
    ALTER TABLE sources ADD CONSTRAINT sources_2024_edition_year
      CHECK (edition <> '5.5e' OR release_year IS NULL OR release_year >= 2024);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS sources_canonical_source_id_idx
  ON sources(canonical_source_id) WHERE canonical_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_publication_code_idx
  ON sources(publication_code) WHERE publication_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_book_identity_idx
  ON sources(canonical_book_id, edition, release_year, publication_revision, language)
  WHERE canonical_book_id IS NOT NULL;
