import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile("migrations/0006_ingestion_generation_integrity.sql", "utf8");

test("migration enforces exact source, file, and generation ownership", () => {
  assert.match(sql, /files_id_source_unique UNIQUE \(id, source_id\)/);
  assert.match(sql, /ingestion_generations_id_file_source_unique[\s\S]*UNIQUE \(id, file_id, source_id\)/);
  assert.match(sql, /FOREIGN KEY \(file_id, source_id\) REFERENCES files\(id, source_id\)/);
  for (const table of ["documents", "pages", "chunks"]) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_generation_fk[\\s\\S]*FOREIGN KEY \\(generation_id, file_id, source_id\\)`),
    );
  }
  assert.match(sql, /FOREIGN KEY \(ingestion_job_id, file_id, source_id\)/);
  assert.match(sql, /FOREIGN KEY \(active_generation_id, id, source_id\)/);
});

test("migration normalizes legacy ownership without replacing content IDs", () => {
  for (const table of ["ingestion_generations", "documents", "pages", "chunks"]) {
    assert.match(sql, new RegExp(`UPDATE ${table} \\w+[\\s\\S]*SET source_id = f.source_id`));
  }
  assert.doesNotMatch(sql, /SET (?:id|generation_id)\s*=/);
  assert.doesNotMatch(sql, /DELETE FROM (?:documents|pages|chunks)/);
});

test("migration serializes queued and processing jobs per file", () => {
  assert.match(sql, /PARTITION BY file_id[\s\S]*ORDER BY \(status = 'processing'\) DESC, queued_at, id/);
  assert.match(sql, /SET status = 'cancelled'/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_one_active_file_idx/);
  assert.match(sql, /WHERE file_id IS NOT NULL AND status IN \('queued', 'processing'\)/);
});

test("migration checks are static because live PostgreSQL is not configured", () => {
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname =/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS files_active_generation_fk/);
});
