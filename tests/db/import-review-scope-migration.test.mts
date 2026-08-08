import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const sql = await readFile("migrations/0023_import_run_review_scope.sql", "utf8");

test("review scope migration is additive, ordered, rerunnable, and nullable for existing runs", () => {
  assert.equal(MIGRATION_FILENAMES.at(-1), "0023_import_run_review_scope.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS allowed_review_entry_types compendium_entry_type\[\]/);
  assert.match(sql, /allowed_review_entry_types IS NULL/);
  assert.match(sql, /cardinality\(allowed_review_entry_types\) > 0/);
  assert.match(sql, /EXCEPTION WHEN duplicate_object THEN NULL/);
  assert.doesNotMatch(sql, /UPDATE compendium_import_runs/);
});
