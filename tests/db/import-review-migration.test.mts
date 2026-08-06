import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const sql = await readFile("migrations/0013_compendium_import_review.sql", "utf8");

test("review migration is additive, rerunnable, and does not publish canonical content", () => {
  assert.ok(MIGRATION_FILENAMES.includes("0013_compendium_import_review.sql"));
  assert.match(sql, /CREATE TABLE IF NOT EXISTS compendium_import_candidate_reviews/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS compendium_import_review_audit/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION compendium_validate_candidate_review/);
  assert.match(sql, /DROP TRIGGER IF EXISTS compendium_candidate_review_valid/);
  assert.match(sql, /EXCEPTION WHEN duplicate_object THEN NULL/);
  assert.doesNotMatch(sql, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?compendium_(?:versions|revisions)\b/i);
});

test("review migration enforces successful runs, immutable audit, and publication safeguards", () => {
  assert.match(sql, /only successful import runs may be reviewed/);
  assert.match(sql, /completed candidate publication state is immutable/);
  assert.match(sql, /publication_status = 'idle' OR decision IN \('approved', 'merged', 'unpublish'\)/);
  assert.match(sql, /candidate review audit records are immutable/);
  assert.match(sql, /compendium_import_review_idempotency_idx/);
});
