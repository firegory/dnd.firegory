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
});
