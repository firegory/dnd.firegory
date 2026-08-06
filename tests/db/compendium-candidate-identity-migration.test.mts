import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const sql = await readFile("migrations/0011_compendium_candidate_identity.sql", "utf8");

test("0011 replaces candidate slot uniqueness with the complete typed identity", () => {
  const identityIndex = MIGRATION_FILENAMES.indexOf("0011_compendium_candidate_identity.sql");
  const reviewIndex = MIGRATION_FILENAMES.indexOf("0013_compendium_import_review.sql");
  assert.ok(identityIndex >= 0 && identityIndex < reviewIndex);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS compendium_import_candidates_slot_unique/);
  assert.match(sql, /DROP INDEX IF EXISTS compendium_import_candidates_slot_unique/);
  assert.match(sql, /IF NOT EXISTS[\s\S]*compendium_import_candidates_identity_slot_unique/);
  assert.match(sql, /UNIQUE NULLS NOT DISTINCT\s*\(import_run_id, entry_type, candidate_key, occurrence_id\)/);
  assert.doesNotMatch(sql, /compendium_(?:versions|revisions)|publication/i);
});
