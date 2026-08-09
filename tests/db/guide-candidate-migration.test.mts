import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const filename = "0016_compendium_guide_candidate_type.sql";
const sql = await readFile(`migrations/${filename}`, "utf8");

test("guide review candidates use a registered additive enum migration", () => {
  assert.ok(MIGRATION_FILENAMES.includes(filename));
  assert.match(sql, /ALTER TYPE compendium_entry_type ADD VALUE IF NOT EXISTS 'guide'/);
  assert.doesNotMatch(sql, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?compendium_(?:versions|revisions)\b/i);
});

test("merged registry orders hierarchy through the historical Species fix", () => {
  assert.deepEqual(MIGRATION_FILENAMES.slice(-10), [
    "0015_spells_vertical_slice.sql",
    "0016_compendium_guide_candidate_type.sql",
    "0017_flat_compendium_types.sql",
    "0018_bestiary_stat_blocks.sql",
    "0019_class_species_hierarchy.sql",
    "0020_active_revision_trigger_fix.sql",
    "0021_nfs_exact_lookup_indexes.sql",
    "0022_import_review_canonical_revision.sql",
    "0023_import_run_review_scope.sql",
    "0024_historical_species_kind.sql",
  ]);
  assert.deepEqual(MIGRATION_FILENAMES, [...MIGRATION_FILENAMES].sort());
});
