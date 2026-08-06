import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const sql = await readFile("migrations/0008_resumable_compendium_imports.sql", "utf8");

test("resumable imports extend the 0007 run and occurrence tables", () => {
  assert.ok(MIGRATION_FILENAMES.includes("0008_resumable_compendium_imports.sql"));
  assert.ok(
    MIGRATION_FILENAMES.indexOf("0008_resumable_compendium_imports.sql")
      < MIGRATION_FILENAMES.indexOf("0010_nfs_content_index_sync.sql"),
  );
  assert.equal(MIGRATION_FILENAMES.some((name) => name.startsWith("0009_")), false);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS compendium_import_(?:runs|occurrences)\b/);
  assert.match(sql, /ALTER TABLE compendium_import_runs/);
  assert.match(sql, /compendium_import_occurrences_candidate_owner_unique/);
});

test("run identity persists versions, input hash, leases, counters, and checkpoints", () => {
  for (const column of ["parser_version", "prompt_version", "model_version", "input_sha256", "checkpoint", "lease_token", "lease_expires_at", "occurrence_count", "candidate_count", "diagnostic_count"]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(sql, /compendium_import_runs_generation_identity_idx[\s\S]*generation_id[\s\S]*WHERE generation_id IS NOT NULL/);
  assert.match(sql, /compendium_import_runs_job_identity_idx[\s\S]*ingestion_job_id[\s\S]*NULLS NOT DISTINCT WHERE generation_id IS NULL/);
  assert.doesNotMatch(sql, /compendium_import_runs_identity_unique/);
  assert.match(sql, /SET ingestion_job_id = generation\.ingestion_job_id[\s\S]*run\.generation_id = generation\.id/);
  assert.match(sql, /compendium_validate_import_run_ownership/);
  assert.match(sql, /generation\.ingestion_job_id IS NOT DISTINCT FROM NEW\.ingestion_job_id/);
  assert.match(sql, /compendium_guard_import_run_lifecycle/);
  assert.match(sql, /UPDATE compendium_import_runs run[\s\S]*run\.status = 'succeeded' THEN 'completed'/);
  assert.match(sql, /run\.status = 'failed' AND EXISTS[\s\S]*THEN 'occurrences'[\s\S]*run\.status = 'failed' THEN 'created'/);
  assert.ok(sql.indexOf("UPDATE compendium_import_runs run") < sql.indexOf("compendium_import_runs_success_checkpoint"));
  assert.match(sql, /import run checkpoints must advance exactly one phase/);
  assert.match(sql, /OLD\.status = 'failed' AND NEW\.status = 'running'/);
  assert.match(sql, /completed import run state is immutable/);
});

test("candidate diffs support every review status without mutating publication", () => {
  for (const status of ["new", "unchanged", "changed", "missing", "duplicate", "invalid"]) {
    assert.match(sql, new RegExp(`'${status}'`));
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS compendium_import_candidates/);
  assert.match(sql, /previous_candidate_id uuid/);
  assert.match(sql, /diff_status = 'missing' AND occurrence_id IS NULL/);
  assert.match(sql, /compendium_import_candidates_slot_unique UNIQUE NULLS NOT DISTINCT/);
  assert.match(sql, /candidate_order integer NOT NULL/);
  assert.match(sql, /compendium_import_candidates_order_unique UNIQUE \(import_run_id, candidate_order\)/);
  assert.doesNotMatch(sql, /UPDATE compendium_(?:versions|revisions)\s+SET/i);
});

test("source artifacts, diagnostics, checkpoints, and audit are retained immutably", () => {
  assert.match(sql, /compendium_validate_candidate_ownership/);
  assert.match(sql, /run_generation\)\s+IS DISTINCT FROM \(NEW\.source_id, NEW\.file_id, NEW\.generation_id\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS compendium_import_checkpoints/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS compendium_import_diagnostics/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS compendium_import_audit/);
  assert.match(sql, /import occurrences, candidates, checkpoints, diagnostics, and audit records are immutable/);
  assert.match(sql, /import occurrences cannot be appended after the occurrence phase/);
  assert.match(sql, /import candidates may only be appended during the diff phase/);
});

test("database publication guard accepts only successful backing runs", () => {
  assert.match(sql, /compendium_require_successful_import_for_publication/);
  assert.match(sql, /run\.status <> 'succeeded'/);
  assert.match(sql, /failed or partial import runs cannot publish revisions/);
  assert.match(sql, /compendium_revisions_import_succeeded/);
  assert.match(sql, /compendium_guard_published_import_link/);
  assert.match(sql, /FOR SHARE OF link, occurrence, run/);
  assert.match(sql, /FROM compendium_revisions WHERE id = locked_revision FOR SHARE/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON compendium_import_links/);
  assert.match(sql, /RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END/);
  assert.match(sql, /compendium_validate_published_import_links/);
  assert.match(sql, /compendium_revisions_import_links_valid[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /compendium_import_links_revision_valid[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /published revisions cannot acquire failed or partial import provenance/);
});
