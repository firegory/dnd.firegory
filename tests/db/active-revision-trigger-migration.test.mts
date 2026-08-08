import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const filename = "0020_active_revision_trigger_fix.sql";
const sql = await readFile(`migrations/${filename}`, "utf8");

test("0020 safely branches before reading table-specific trigger records", () => {
  assert.equal(MIGRATION_FILENAMES.at(-1), filename);
  assert.match(sql, /IF TG_TABLE_NAME = 'compendium_versions' THEN\s+target_version := NEW\.id;\s+ELSE\s+target_version := NEW\.version_id;/);
  assert.doesNotMatch(sql, /target_version := CASE/);
  assert.match(sql, /compendium_revision_has_projection\(active_revision, active_type\)/);
});
