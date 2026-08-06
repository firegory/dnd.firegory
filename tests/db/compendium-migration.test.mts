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
  assert.match(sql, /active_revision_id uuid NOT NULL/);
  assert.match(sql, /lifecycle = 'draft' AND published_at IS NULL/);
  assert.match(sql, /lifecycle = 'published' AND active_revision_id IS NOT NULL/);
  assert.match(sql, /FOREIGN KEY \(active_revision_id, id\)[\s\S]*REFERENCES compendium_revisions\(id, version_id\)/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER compendium_versions_active_revision_valid/);
  assert.match(sql, /compendium_revisions_version_type_fk[\s\S]*REFERENCES compendium_versions\(id, entry_type\) DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /FROM compendium_versions v WHERE v\.id = target_version/);
  assert.match(sql, /every compendium version requires its own active revision/);
  assert.match(sql, /compendium_revision_has_projection\(active_revision, active_type\)/);
  assert.match(sql, /compendium version lifecycle cannot move backwards/);
});

test("slugs and aliases share one normalized conflict scope", () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION compendium_normalize_name/);
  assert.match(sql, /normalize\(value, NFC\)/);
  assert.match(sql, /server_encoding'[\s\S]*UTF8/);
  assert.match(sql, /collname = 'und-x-icu'[\s\S]*collnamespace = 'pg_catalog'::regnamespace[\s\S]*collprovider = 'i' AND collisdeterministic/);
  assert.match(sql, /lower\([\s\S]*COLLATE pg_catalog\."und-x-icu"/);
  assert.match(sql, /normalized_name text COLLATE pg_catalog\."und-x-icu"[\s\S]*GENERATED ALWAYS/);
  assert.match(sql, /UNIQUE \(entry_type, edition, language, normalized_name\)/);
  assert.match(sql, /compendium_names_one_slug_per_version_idx[\s\S]*WHERE kind = 'slug'/);
});

test("relations and imports have real edition and production-record links", () => {
  assert.match(sql, /compendium_relations_source_edition_fk[\s\S]*REFERENCES compendium_entries\(id, edition\)/);
  assert.match(sql, /compendium_relations_target_edition_fk[\s\S]*REFERENCES compendium_entries\(id, edition\)/);
  assert.match(sql, /compendium_import_occurrences_run_generation_fk[\s\S]*REFERENCES compendium_import_runs\(id, source_id, file_id, generation_id\)/);
  assert.match(sql, /run_generation IS DISTINCT FROM NEW\.generation_id/);
  assert.match(sql, /import run generation is immutable after its first occurrence/);
  assert.match(sql, /compendium_import_occurrences_chunk_owner_fk/);
  assert.match(sql, /compendium_import_links_occurrence_owner_fk[\s\S]*\(occurrence_id, source_id, file_id\)/);
  assert.match(sql, /compendium_import_links_version_owner_fk[\s\S]*REFERENCES compendium_versions\(id, entry_id, source_id, file_id\)/);
  assert.match(sql, /compendium_import_links_revision_owner_fk[\s\S]*REFERENCES compendium_revisions\(id, version_id\)/);
  assert.match(sql, /compendium_import_links_relation_owner_fk[\s\S]*REFERENCES compendium_entry_relations\(id, source_entry_id\)/);
  assert.doesNotMatch(sql, /entry_id uuid REFERENCES compendium_entries/);
});

test("citations enforce revision, version, source, file, generation, and chunk ownership", () => {
  assert.match(sql, /FOREIGN KEY \(revision_id, version_id\)[\s\S]*REFERENCES compendium_revisions\(id, version_id\)/);
  assert.match(sql, /FOREIGN KEY \(version_id, source_id, file_id\)[\s\S]*REFERENCES compendium_versions\(id, source_id, file_id\)/);
  assert.match(sql, /FOREIGN KEY \(chunk_id, generation_id, file_id, source_id\)[\s\S]*REFERENCES chunks\(id, generation_id, file_id, source_id\)/);
  assert.match(sql, /quote_span_end - quote_span_start = char_length\(quote\)/);
  assert.match(sql, /substring\(chunk_quote FROM NEW\.quote_span_start \+ 1/);
  assert.match(sql, /compendium_citations_exact_quote/);
  assert.match(sql, /generation_status NOT IN \('active', 'archived'\)/);
  assert.match(sql, /chunks_citation_immutable/);
  assert.match(sql, /ingestion_generations_citation_lifecycle/);
  assert.doesNotMatch(sql, /chunk_ids\s+uuid\[\]/);
});

test("citation lifecycle blocks staged evidence without blocking archival", () => {
  assert.match(sql, /citations require chunks from active or archived generations/);
  assert.match(sql, /OLD\.status = 'active' AND NEW\.status = 'archived'/);
  assert.match(sql, /only permits the active to archived transition/);
  assert.match(sql, /referenced citation chunk text and ownership are immutable/);
});

test("revisions and all existing children are immutable", () => {
  assert.match(sql, /compendium_guard_revision_immutability/);
  assert.match(sql, /immutable except for draft publication/);
  assert.match(sql, /compendium_guard_revision_children_immutability/);
  assert.match(sql, /old_revision := OLD\.revision_id/);
  assert.match(sql, /new_revision := CASE WHEN TG_OP = 'UPDATE' THEN NEW\.revision_id/);
  assert.match(sql, /revision children are immutable/);
  assert.match(sql, /r\.created_at = transaction_timestamp\(\)/);
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
  assert.match(sql, /challenge_rating numeric\(5,3\)/);
  assert.match(sql, /challenge_rating IN \(0, 0\.125, 0\.25, 0\.5\)/);
  assert.match(sql, /CHECK \(hit_die IN \(6, 8, 10, 12\)\)/);
  assert.match(sql, /CHECK \(prerequisite_level IS NULL OR prerequisite_level BETWEEN 1 AND 20\)/);
  assert.match(sql, /cost_cp BETWEEN 0 AND 2147483647/);
  assert.match(sql, /weight_lb numeric\(10,3\)/);
  assert.match(sql, /CHECK \(jsonb_typeof\(extension_data\) = 'object'\)/);
});

test("migration integrity checks are static when no live PostgreSQL is available", () => {
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/);
  assert.match(sql, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/);
  assert.match(sql, /DROP TRIGGER IF EXISTS/);
});
