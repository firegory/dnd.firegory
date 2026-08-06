import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

test("NFS index sync uses reserved migration 0010 and explicit managed ownership", async () => {
  assert.equal(MIGRATION_FILENAMES.at(-1), "0010_nfs_content_index_sync.sql");
  assert.equal(MIGRATION_FILENAMES.some((name) => name.startsWith("0008_") || name.startsWith("0009_")), false);
  const sql = await readFile(resolve("migrations/0010_nfs_content_index_sync.sql"), "utf8");
  for (const table of [
    "nfs_index_sync_runs",
    "nfs_index_sync_staging",
    "nfs_index_managed_sources",
    "nfs_index_managed_files",
    "nfs_index_entries",
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /projection_hash text NOT NULL/);
  assert.match(sql, /projector_version integer NOT NULL/);
  assert.match(sql, /payload_hash text NOT NULL/);
  assert.match(sql, /owner_token uuid/);
  assert.match(sql, /lease_expires_at timestamptz/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS owner_token uuid/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION claim_nfs_index_sync_run/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /Superseded after sync owner lease expired/);
  assert.match(sql, /active_run\.owner_token = p_owner_token[\s\S]*active_run\.lease_expires_at > lease_now/);
  assert.match(sql, /active_run\.status = 'staging'[\s\S]*active_run\.projection_hash = p_projection_hash[\s\S]*SET owner_token = p_owner_token/);
  assert.match(sql, /WHERE id = active_run\.id AND status IN \('staging', 'applying'\)/);
  assert.match(sql, /nfs_index_sync_runs_one_inflight_repository_idx[\s\S]*WHERE status IN \('staging', 'applying'\)/);
  assert.match(sql, /terminal NFS index sync status is immutable/);
  assert.match(sql, /cannot move backwards from applying/);
  assert.doesNotMatch(sql, /\b(?:users|sessions|search_events|rag_events)\b/);
});
