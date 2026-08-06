import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const sql = await readFile("migrations/0003_source_publication_metadata.sql", "utf8");

test("publication migration is registered after existing migrations", () => {
  assert.deepEqual(MIGRATION_FILENAMES, [
    "0001_initial_schema.sql",
    "0002_telegram_links.sql",
    "0003_source_publication_metadata.sql",
  ]);
});

test("publication migration projects canonical identity fields and is rerunnable", () => {
  for (const column of [
    "canonical_source_id text",
    "publication_code text",
    "publication_title text",
    "publisher text",
    "release_year integer",
    "publication_revision text",
    "external_origin_url text",
    "external_origin_id text",
    "attribution text",
    "source_priority integer",
    "canonical_book_id text",
    "license text",
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/);
  assert.match(sql, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/);
});

test("publication migration documents and applies legacy defaults", () => {
  assert.match(sql, /Existing sources retain their display title as publication_title/);
  assert.match(sql, /SET publication_title = title/);
  assert.match(sql, /source_priority integer NOT NULL DEFAULT 0/);
});

test("database constraints preserve publication and edition invariants", () => {
  for (const constraint of [
    "sources_release_year_range",
    "sources_revision_has_release_year",
    "sources_origin_complete",
    "sources_priority_range",
    "sources_canonical_book_id_format",
    "sources_2024_edition_year",
  ]) {
    assert.match(sql, new RegExp(constraint));
  }
  assert.match(sql, /release_year IS NULL OR release_year BETWEEN 1974 AND 2100/);
  assert.match(sql, /publication_revision IS NULL OR release_year IS NOT NULL/);
  assert.match(sql, /external_origin_url IS NULL AND external_origin_id IS NULL/);
  assert.match(sql, /source_priority BETWEEN 0 AND 1000/);
  assert.match(sql, /edition <> '5\.5e' OR release_year IS NULL OR release_year >= 2024/);
});

test("static migration SQL guards every additive operation and orders the legacy backfill", () => {
  const addedColumns = sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
  const addedConstraints = sql.match(/ADD CONSTRAINT/g) ?? [];
  const guardedConstraints = sql.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname =/g) ?? [];
  const indexes = sql.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/g) ?? [];

  assert.equal(addedColumns.length, 12);
  assert.equal(addedConstraints.length, guardedConstraints.length);
  assert.equal(indexes.length, 3);
  assert.ok(sql.indexOf("SET publication_title = title") < sql.indexOf("ALTER COLUMN publication_title SET NOT NULL"));
  assert.doesNotMatch(sql, /\b(?:DROP|RENAME)\b/);
});
