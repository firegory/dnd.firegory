-- Exact detail lookups must narrow the NFS corpus before materializing all
-- accessible spell versions. Normalize aliases with the same semantics used by
-- compendium detail routes so both entry IDs and aliases have selective indexes.
CREATE OR REPLACE FUNCTION nfs_index_normalized_aliases(alias_values jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(compendium_normalize_name(value)), ARRAY[]::text[])
  FROM jsonb_array_elements_text(alias_values) value
$$;

CREATE INDEX IF NOT EXISTS nfs_index_entries_active_entry_id_idx
  ON nfs_index_entries (entry_id)
  WHERE lifecycle = 'active';

CREATE INDEX IF NOT EXISTS nfs_index_entries_active_aliases_idx
  ON nfs_index_entries USING gin (nfs_index_normalized_aliases(aliases))
  WHERE lifecycle = 'active';
