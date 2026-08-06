-- Harden source projection constraints to match canonical source.json values.
-- PostgreSQL cannot reproduce full WHATWG URL parsing, but it rejects direct
-- writes that violate the HTTP(S) scheme, authority, whitespace, and
-- percent-encoding rules enforced by the application.
-- Both schemes are retained for lossless upgrades from 0003, which accepted
-- paired HTTP origins.
-- The hardened origin check is NOT VALID so legacy rows cannot block this
-- migration; PostgreSQL still enforces it for every new or updated row.

ALTER TABLE sources
  DROP CONSTRAINT IF EXISTS sources_publication_text_not_blank,
  DROP CONSTRAINT IF EXISTS sources_publication_code_format,
  DROP CONSTRAINT IF EXISTS sources_origin_complete;

ALTER TABLE sources
  ADD CONSTRAINT sources_publication_text_not_blank CHECK (
    title !~ '^[[:space:]]*$'
    AND publication_title !~ '^[[:space:]]*$'
    AND (publisher IS NULL OR publisher !~ '^[[:space:]]*$')
    AND (publication_revision IS NULL OR publication_revision !~ '^[[:space:]]*$')
    AND (attribution IS NULL OR attribution !~ '^[[:space:]]*$')
    AND (license IS NULL OR license !~ '^[[:space:]]*$')
  ),
  ADD CONSTRAINT sources_publication_code_format CHECK (
    publication_code IS NULL OR publication_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  ),
  ADD CONSTRAINT sources_origin_complete CHECK (
    (external_origin_url IS NULL AND external_origin_id IS NULL)
    OR (
      external_origin_url IS NOT NULL
      AND external_origin_id IS NOT NULL
      AND external_origin_id !~ '^[[:space:]]*$'
      AND external_origin_url ~ '^https?://[^%[:space:]/?#]+'
      AND external_origin_url !~ '[[:space:]]'
      AND external_origin_url !~ '%([^0-9A-Fa-f]|[0-9A-Fa-f]([^0-9A-Fa-f]|$)|$)'
    )
  ) NOT VALID;
