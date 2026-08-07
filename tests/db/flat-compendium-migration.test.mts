import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const sql = await readFile("migrations/0017_flat_compendium_types.sql", "utf8");
test("0017 adds constrained flat projections and browse indexes", () => {
  assert.equal(MIGRATION_FILENAMES.at(-1), "0017_flat_compendium_types.sql");
  assert.match(sql, /ALTER TYPE compendium_entry_type ADD VALUE IF NOT EXISTS 'glossary'/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS compendium_glossary/);
  for (const type of ["backgrounds", "feats", "items", "equipment", "glossary"]) assert.match(sql, new RegExp(`compendium_${type}_filters_idx`));
  assert.match(sql, /compendium_glossary_related_terms_valid/);
  assert.match(sql, /compendium_revision_child_immutable[\s\S]*compendium_glossary/);
  assert.doesNotMatch(sql, /\b(?:DELETE\s+FROM|TRUNCATE|DROP TABLE)\b/i);
});
