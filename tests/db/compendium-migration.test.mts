import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const sql = await readFile("migrations/0007_compendium_relational_core.sql", "utf8");

test("compendium migration is the next registered additive migration", () => {
  assert.equal(MIGRATION_FILENAMES.at(-1), "0007_compendium_relational_core.sql");
  assert.doesNotMatch(sql, /(?:DELETE|UPDATE) FROM (?:sources|files|chunks|documents|pages)\b/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS compendium_entries/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS compendium_versions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS compendium_revisions/);
});

test("versions retain one exact source access boundary and active revision policy", () => {
  assert.match(sql, /FOREIGN KEY \(source_id, edition, language\)[\s\S]*REFERENCES sources\(id, edition, language\)/);
  assert.match(sql, /FOREIGN KEY \(file_id, source_id\)[\s\S]*REFERENCES files\(id, source_id\)/);
  assert.match(sql, /lifecycle = 'draft' AND active_revision_id IS NULL/);
  assert.match(sql, /lifecycle = 'published' AND active_revision_id IS NOT NULL/);
  assert.match(sql, /FOREIGN KEY \(active_revision_id, id\)[\s\S]*REFERENCES compendium_revisions\(id, version_id\)/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER compendium_versions_active_revision_valid/);
  assert.match(sql, /r\.lifecycle = 'published'/);
  assert.match(sql, /compendium_revision_has_projection\(NEW\.active_revision_id, active_type\)/);
  assert.match(sql, /compendium version lifecycle cannot move backwards/);
});

test("slugs and aliases share one normalized conflict scope", () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION compendium_normalize_name/);
  assert.match(sql, /normalized_name text GENERATED ALWAYS/);
  assert.match(sql, /UNIQUE \(entry_type, edition, language, normalized_name\)/);
  assert.match(sql, /compendium_names_one_slug_per_version_idx[\s\S]*WHERE kind = 'slug'/);
});

test("relations and imports have real edition and production-record links", () => {
  assert.match(sql, /compendium_relations_source_edition_fk[\s\S]*REFERENCES compendium_entries\(id, edition\)/);
  assert.match(sql, /compendium_relations_target_edition_fk[\s\S]*REFERENCES compendium_entries\(id, edition\)/);
  assert.match(sql, /compendium_import_occurrences_run_owner_fk/);
  assert.match(sql, /compendium_import_occurrences_chunk_owner_fk/);
  for (const target of ["entry_id", "version_id", "revision_id", "relation_id"]) {
    assert.match(sql, new RegExp(`${target} uuid REFERENCES compendium_`));
  }
  assert.match(sql, /num_nonnulls\(entry_id, version_id, revision_id, relation_id\) = 1/);
});

test("citations enforce revision, version, source, file, generation, and chunk ownership", () => {
  assert.match(sql, /FOREIGN KEY \(revision_id, version_id\)[\s\S]*REFERENCES compendium_revisions\(id, version_id\)/);
  assert.match(sql, /FOREIGN KEY \(version_id, source_id, file_id\)[\s\S]*REFERENCES compendium_versions\(id, source_id, file_id\)/);
  assert.match(sql, /FOREIGN KEY \(chunk_id, generation_id, file_id, source_id\)[\s\S]*REFERENCES chunks\(id, generation_id, file_id, source_id\)/);
  assert.match(sql, /quote_span_end - quote_span_start = char_length\(quote\)/);
  assert.match(sql, /substring\(chunk_quote FROM NEW\.quote_span_start \+ 1/);
  assert.match(sql, /compendium_citations_exact_quote/);
  assert.doesNotMatch(sql, /chunk_ids\s+uuid\[\]/);
});

test("revisions and their published children are immutable", () => {
  assert.match(sql, /compendium_guard_revision_immutability/);
  assert.match(sql, /immutable except for draft publication/);
  assert.match(sql, /compendium_guard_published_revision_children/);
  assert.match(sql, /published revision citations and projections are immutable/);
  assert.match(sql, /compendium_versions_boundary_immutable/);
});

test("all supported domains use discriminator FKs and constrained typed fields", () => {
  for (const [table, type] of [
    ["spells", "spell"], ["creatures", "creature"], ["items", "item"], ["classes", "class"],
    ["features", "feature"], ["species", "species"], ["backgrounds", "background"],
    ["feats", "feat"], ["equipment", "equipment"],
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS compendium_${table}`));
    assert.match(sql, new RegExp(`GENERATED ALWAYS AS \\('${type}'::compendium_entry_type\\)`));
  }
  assert.match(sql, /CHECK \(level BETWEEN 0 AND 9\)/);
  assert.match(sql, /CHECK \(challenge_rating BETWEEN 0 AND 30\)/);
  assert.match(sql, /CHECK \(hit_die IN \(6, 8, 10, 12\)\)/);
  assert.match(sql, /CHECK \(prerequisite_level IS NULL OR prerequisite_level BETWEEN 1 AND 20\)/);
  assert.match(sql, /CHECK \(jsonb_typeof\(extension_data\) = 'object'\)/);
});

test("migration integrity checks are static when no live PostgreSQL is available", () => {
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/);
  assert.match(sql, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/);
  assert.match(sql, /DROP TRIGGER IF EXISTS/);
});
