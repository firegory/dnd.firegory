import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const filename = "0021_nfs_exact_lookup_indexes.sql";
const sql = await readFile(`migrations/${filename}`, "utf8");

test("0021 adds normalized alias and entry ID indexes for exact NFS lookups", () => {
  assert.equal(MIGRATION_FILENAMES[MIGRATION_FILENAMES.indexOf(filename) + 1], "0022_import_review_canonical_revision.sql");
  assert.match(sql, /nfs_index_normalized_aliases\(alias_values jsonb\) RETURNS text\[\]/);
  assert.match(sql, /array_agg\(compendium_normalize_name\(value\)\)/);
  assert.match(sql, /nfs_index_entries_active_entry_id_idx[\s\S]*ON nfs_index_entries \(entry_id\)/);
  assert.match(sql, /nfs_index_entries_active_aliases_idx[\s\S]*USING gin \(nfs_index_normalized_aliases\(aliases\)\)/);
  assert.match(sql, /WHERE lifecycle = 'active'/);
});
