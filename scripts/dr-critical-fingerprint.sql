CREATE TEMP TABLE dr_critical_fingerprints (
  table_name text PRIMARY KEY,
  row_count bigint NOT NULL,
  fingerprint_sha256 text NOT NULL
);

DO $$
DECLARE
  critical_table text;
  count_value bigint;
  fingerprint_value text;
BEGIN
  FOREACH critical_table IN ARRAY ARRAY[
    'users',
    'sessions',
    'search_events',
    'rag_events',
    'compendium_import_audit',
    'compendium_import_review_audit',
    'compendium_editor_audit',
    'ingestion_jobs'
  ] LOOP
    EXECUTE format(
      'SELECT count(*), encode(digest(coalesce(string_agg(row_hash, '''' ORDER BY row_hash), ''''), ''sha256''), ''hex'') FROM (SELECT encode(digest(to_jsonb(row_value)::text, ''sha256''), ''hex'') AS row_hash FROM %I row_value) hashed',
      critical_table
    ) INTO count_value, fingerprint_value;
    INSERT INTO dr_critical_fingerprints VALUES (critical_table, count_value, fingerprint_value);
  END LOOP;
END $$;

COPY (
  SELECT table_name, row_count, fingerprint_sha256
  FROM dr_critical_fingerprints
  ORDER BY table_name
) TO STDOUT WITH (FORMAT csv, HEADER true);
