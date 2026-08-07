import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const sql = await readFile("migrations/0015_spells_vertical_slice.sql", "utf8");

test("0015 registers the additive typed spell projection migration", () => {
  assert.equal(MIGRATION_FILENAMES.at(-1), "0015_spells_vertical_slice.sql");
  assert.match(sql, /ALTER TABLE compendium_spells[\s\S]*ADD COLUMN IF NOT EXISTS classes text\[\]/);
  assert.match(sql, /compendium_spells_classes_valid/);
  assert.match(sql, /USING gin \(classes\)/);
  assert.match(sql, /compendium_spells_filters_idx[\s\S]*level, school, ritual, concentration, revision_id/);
  assert.match(sql, /ALTER TABLE compendium_import_occurrences[\s\S]*raw_blob_path text[\s\S]*source_fetched_at timestamptz/);
  assert.match(sql, /raw_blob_path ~ '\^blobs\/\[0-9a-f\]\{64\}/);
  assert.doesNotMatch(sql, /\b(?:DELETE|TRUNCATE|DROP TABLE)\b/i);
});
