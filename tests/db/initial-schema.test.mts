import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationSql = await readFile("migrations/0001_initial_schema.sql", "utf8");
const publicationMigrationSql = await readFile("migrations/0003_publication_fencing_token.sql", "utf8");

test("initial migration enables required Postgres extensions", () => {
  assert.match(migrationSql, /CREATE EXTENSION IF NOT EXISTS pgcrypto;/);
  assert.match(migrationSql, /CREATE EXTENSION IF NOT EXISTS vector;/);
});

test("initial migration creates required MVP tables", () => {
  for (const table of [
    "users",
    "sessions",
    "sources",
    "files",
    "ingestion_jobs",
    "documents",
    "pages",
    "chunks",
    "search_events",
    "rag_events",
  ]) {
    assert.match(migrationSql, new RegExp(`CREATE TABLE ${table} \\(`));
  }
});

test("source schema stores corpus and access metadata", () => {
  for (const enumType of [
    "source_category",
    "source_edition",
    "source_language",
    "access_tier",
  ]) {
    assert.match(migrationSql, new RegExp(`CREATE TYPE ${enumType} AS ENUM`));
  }

  assert.match(migrationSql, /owner_user_id uuid REFERENCES users\(id\)/);
  assert.match(migrationSql, /metadata jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
});

test("file, page, and chunk schema preserves original and processed artifact metadata", () => {
  for (const column of [
    "storage_path text NOT NULL",
    "processed_artifacts_root text",
    "artifacts_root text",
    "document_type text NOT NULL DEFAULT 'pdf'",
    "document_id uuid REFERENCES documents",
    "page_number integer NOT NULL",
    "text_span_start integer",
    "text_span_end integer",
    "bbox jsonb",
  ]) {
    assert.match(migrationSql, new RegExp(column));
  }
});

test("chunks can store pgvector embeddings and search indexes", () => {
  assert.match(migrationSql, /embedding vector\(1024\)/);
  assert.match(migrationSql, /USING hnsw \(embedding vector_cosine_ops\)/);
  assert.match(migrationSql, /chunks_text_search_idx/);
});

test("publication migration creates a monotonic bigint fencing sequence", () => {
  assert.match(publicationMigrationSql, /CREATE SEQUENCE publication_fencing_token_seq AS bigint;/);
});
