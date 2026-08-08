import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const sql = await readFile("migrations/0022_import_review_canonical_revision.sql", "utf8");

test("review outcomes persist exact canonical revision identity without inventing history", () => {
  assert.ok(MIGRATION_FILENAMES.includes("0022_import_review_canonical_revision.sql"));
  assert.match(sql, /ADD COLUMN IF NOT EXISTS canonical_revision_id text/);
  assert.match(sql, /canonical_revision_id IS NULL OR canonical_revision_id ~ '\^rev-/);
  assert.match(sql, /publication_status = 'completed' AND decision IN \('approved', 'merged'\)/);
  assert.match(sql, /NOT VALID/);
  assert.doesNotMatch(sql, /compendium_import_occurrences|sources\/.*\/evidence/);
});
