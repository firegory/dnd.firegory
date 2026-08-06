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
  assert.match(sql, /nfs_index_sync_runs_one_inflight_repository_idx[\s\S]*WHERE status IN \('staging', 'applying'\)/);
  assert.match(sql, /terminal NFS index sync status is immutable/);
  assert.match(sql, /cannot move backwards from applying/);
  assert.doesNotMatch(sql, /\b(?:users|sessions|search_events|rag_events)\b/);
});
