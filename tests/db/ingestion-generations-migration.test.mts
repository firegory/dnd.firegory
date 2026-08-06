import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile("migrations/0005_ingestion_generations.sql", "utf8");

test("generation migration preserves legacy page and chunk identifiers", () => {
  assert.match(sql, /INSERT INTO ingestion_generations[\s\S]*FROM files f/);
  assert.match(sql, /UPDATE files f[\s\S]*active_generation_id = g\.id/);
  assert.match(sql, /UPDATE pages p[\s\S]*generation_id = f\.active_generation_id/);
  assert.match(sql, /UPDATE chunks c[\s\S]*generation_id = f\.active_generation_id/);
  assert.doesNotMatch(sql, /UPDATE (?:pages|chunks)[\s\S]*\bSET\s+id\s*=/);
  assert.doesNotMatch(sql, /DELETE FROM (?:pages|chunks)/);
});

test("generation ownership retains history with generation-scoped uniqueness", () => {
  assert.match(sql, /UNIQUE \(id, file_id\)/);
  assert.match(sql, /FOREIGN KEY \(generation_id, file_id\)/g);
  assert.match(sql, /ON DELETE CASCADE/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS pages_file_id_page_number_key/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS chunks_file_id_chunk_index_key/);
  assert.match(sql, /ON pages\(generation_id, page_number\)/);
  assert.match(sql, /ON chunks\(generation_id, chunk_index\)/);
});

test("migration supports one active generation and nullable initial activation", () => {
  assert.match(sql, /one_active_file_idx[\s\S]*WHERE status = 'active'/);
  assert.match(sql, /FOREIGN KEY \(active_generation_id, id\)/);
  assert.doesNotMatch(sql, /files ALTER COLUMN active_generation_id SET NOT NULL/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS active_generation_id/);
});

test("migration additive operations are rerunnable", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ingestion_generations/);
  assert.equal((sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length, 4);
  assert.ok((sql.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/g) ?? []).length >= 6);
  assert.equal(
    (sql.match(/ADD CONSTRAINT (?:files_active_generation_fk|documents_generation_fk|pages_generation_fk|chunks_generation_fk)/g) ?? []).length,
    4,
  );
});
