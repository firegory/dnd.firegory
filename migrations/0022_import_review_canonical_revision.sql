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

ALTER TABLE compendium_import_occurrences
  DROP CONSTRAINT IF EXISTS compendium_import_occurrences_raw_evidence;
ALTER TABLE compendium_import_occurrences
  ADD CONSTRAINT compendium_import_occurrences_raw_evidence CHECK (
    (raw_blob_path IS NULL AND source_fetched_at IS NULL)
    OR (source_fetched_at IS NOT NULL AND (
      raw_blob_path = 'blobs/' || fingerprint_sha256 || '.html'
      OR raw_blob_path ~ ('^sources/[a-z0-9]([a-z0-9-]{0,126}[a-z0-9])?/evidence/' || fingerprint_sha256 || '\.html$')
    ))
  );

ALTER TABLE compendium_import_occurrences
  DROP CONSTRAINT IF EXISTS compendium_import_occurrences_index_evidence;
ALTER TABLE compendium_import_occurrences
  ADD CONSTRAINT compendium_import_occurrences_index_evidence CHECK (
    (index_locator IS NULL AND index_fingerprint_sha256 IS NULL AND raw_index_blob_path IS NULL
      AND index_source_fetched_at IS NULL AND index_card_fingerprint_sha256 IS NULL AND metadata_evidence_text IS NULL)
    OR (index_locator ~ '^https://' AND index_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
      AND (raw_index_blob_path = 'blobs/' || index_fingerprint_sha256 || '.html'
        OR raw_index_blob_path ~ ('^sources/[a-z0-9]([a-z0-9-]{0,126}[a-z0-9])?/evidence/' || index_fingerprint_sha256 || '\.html$'))
      AND index_source_fetched_at IS NOT NULL AND index_card_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
      AND length(metadata_evidence_text) > 0)
  );
