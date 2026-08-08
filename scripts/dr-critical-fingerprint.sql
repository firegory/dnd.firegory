CREATE TEMP TABLE dr_critical_fingerprints (
  table_name text PRIMARY KEY,
  row_count bigint NOT NULL,
  hash_xor_seed_0 bigint NOT NULL,
  hash_xor_seed_1 bigint NOT NULL,
  hash_sum_seed_2 numeric NOT NULL
);

DO $$
DECLARE
  critical_table text;
  count_value bigint;
  xor_0 bigint;
  xor_1 bigint;
  sum_2 numeric;
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
      'SELECT count(*), coalesce(bit_xor(hashtextextended(row_json, 0)), 0), coalesce(bit_xor(hashtextextended(row_json, 1)), 0), coalesce(sum(hashtextextended(row_json, 2)::numeric), 0) FROM (SELECT to_jsonb(row_value)::text AS row_json FROM %I row_value) canonical_rows',
      critical_table
    ) INTO count_value, xor_0, xor_1, sum_2;
    INSERT INTO dr_critical_fingerprints VALUES (critical_table, count_value, xor_0, xor_1, sum_2);
  END LOOP;
END $$;

COPY (
  SELECT table_name, row_count, hash_xor_seed_0, hash_xor_seed_1, hash_sum_seed_2
  FROM dr_critical_fingerprints
  ORDER BY table_name
) TO STDOUT WITH (FORMAT csv, HEADER true);
