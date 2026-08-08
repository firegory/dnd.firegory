import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const sql = await readFile("migrations/0014_compendium_entry_editor.sql", "utf8");

test("migration 0014 is registered, additive, and rerunnable", () => {
  assert.ok(MIGRATION_FILENAMES.includes("0014_compendium_entry_editor.sql"));
  assert.match(sql,/ADD COLUMN IF NOT EXISTS based_on_revision_id/);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS compendium_editor_publications/);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS compendium_editor_audit/);
  assert.match(sql,/EXCEPTION WHEN duplicate_object THEN NULL/);
  assert.doesNotMatch(sql,/DELETE FROM compendium_/i);
  assert.match(sql,/UPDATE compendium_versions SET editor_head_revision_id = active_revision_id/);
  assert.ok(
    sql.indexOf("CREATE OR REPLACE FUNCTION compendium_validate_active_revision()")
      < sql.indexOf("UPDATE compendium_versions SET editor_head_revision_id"),
    "the dual-path trigger repair must precede the data backfill",
  );
  assert.match(sql, /IF TG_TABLE_NAME = 'compendium_versions' THEN\s+target_version := NEW\.id;\s+ELSE\s+target_version := NEW\.version_id;/);
});

test("migration 0014 enforces immutable audit, constrained outcomes, and version-owned revisions", () => {
  assert.match(sql,/compendium_editor_one_open_publication_idx/);
  assert.match(sql,/expected_active_revision_id.*rev-/s);
  assert.match(sql,/editor publication commands are immutable/);
  assert.match(sql,/editor audit records are immutable/);
  assert.match(sql,/FOREIGN KEY \(revision_id, version_id\)/);
  assert.match(sql,/btrim\(actor\).*btrim\(reason\)/s);
  assert.match(sql,/based_on_revision_id IS NULL AND created_by IS NULL/);
  assert.match(sql,/created_by IS NOT NULL AND change_reason IS NOT NULL/);
  assert.match(sql,/compendium_versions_editor_head_fk/);
});
