ALTER TABLE compendium_import_candidate_reviews
  ADD COLUMN IF NOT EXISTS canonical_revision_id text;

ALTER TABLE compendium_import_candidate_reviews
  DROP CONSTRAINT IF EXISTS compendium_review_canonical_revision_format;
ALTER TABLE compendium_import_candidate_reviews
  ADD CONSTRAINT compendium_review_canonical_revision_format CHECK (
    canonical_revision_id IS NULL OR canonical_revision_id ~ '^rev-[0-9a-f]{64}$'
  );

ALTER TABLE compendium_import_candidate_reviews
  DROP CONSTRAINT IF EXISTS compendium_review_canonical_revision_shape;
ALTER TABLE compendium_import_candidate_reviews
  ADD CONSTRAINT compendium_review_canonical_revision_shape CHECK (
    (publication_status = 'completed' AND decision IN ('approved', 'merged')) = (canonical_revision_id IS NOT NULL)
  ) NOT VALID;
