import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { CanonicalRevision } from "../../src/server/content-storage/repository.ts";
import { assertCanonicalRevision, loadResolvedCanonicalRevisions } from "../../src/server/content-storage/validation.ts";
import { buildSyncPlan } from "../../src/server/content-index/sync.ts";
import { synchronizeContentIndex } from "../../src/server/content-index/sync.ts";
import { deterministicUuid, projectCanonicalRevisions, projectionHash } from "../../src/server/content-index/projection.ts";

const dataRoot = resolve("content-repository");

test("canonical projection deterministically rebuilds entries, pages, and chunks without embeddings", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const first = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions);
  const second = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions);

  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].entryType, "action");
  assert.deepEqual(first[0].pages, [{
    pageNumber: 72,
    text: "When you take the Dash action, you gain extra movement for the current turn.",
  }]);
  assert.equal(first[0].chunks.length, 1);
  assert.equal(first[0].chunks[0].pageNumber, null);
  assert.equal("embedding" in first[0].chunks[0], false);
  assert.equal(first[0].chunks[0].text, first[0].plainText);
});

test("projection and manifest identities are stable and content-derived", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const hash = projectionHash(resolved.manifest.repositoryId, resolved.revisions);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hash, projectionHash(resolved.manifest.repositoryId, resolved.revisions));
  assert.equal(
    deterministicUuid("scope", "a", "b"),
    deterministicUuid("scope", "a", "b"),
  );
  assert.notEqual(deterministicUuid("scope", "a", "b"), deterministicUuid("scope", "a", "c"));
});

test("incremental planning is idempotent and isolates changed and removed managed entries", () => {
  const desired = [
    { entryId: "added", revisionId: `rev-${"a".repeat(64)}`, contentHash: `sha256:${"a".repeat(64)}` },
    { entryId: "changed", revisionId: `rev-${"b".repeat(64)}`, contentHash: `sha256:${"b".repeat(64)}` },
    { entryId: "same", revisionId: `rev-${"c".repeat(64)}`, contentHash: `sha256:${"c".repeat(64)}` },
  ];
  const active = [
    { entry_id: "changed", revision_id: `rev-${"d".repeat(64)}`, content_hash: `sha256:${"d".repeat(64)}` },
    { entry_id: "removed", revision_id: `rev-${"e".repeat(64)}`, content_hash: `sha256:${"e".repeat(64)}` },
    { entry_id: "same", revision_id: `rev-${"c".repeat(64)}`, content_hash: `sha256:${"c".repeat(64)}` },
  ];
  assert.deepEqual(buildSyncPlan("incremental", desired, active), {
    additions: ["added"], updates: ["changed"], removals: ["removed"],
  });
  assert.deepEqual(buildSyncPlan("incremental", desired, desired.map((entry) => ({
    entry_id: entry.entryId, revision_id: entry.revisionId, content_hash: entry.contentHash,
  }))), { additions: [], updates: [], removals: [] });
  assert.deepEqual(buildSyncPlan("clean", desired, active).updates, ["changed", "same"]);
});

test("corrupt canonical hashes are rejected before projection", async () => {
  const path = resolve(dataRoot, "compendium/dash/revisions/rev-42eaa0fa9421910cca58164912c48bd4bf8b39fbba226808f920e35dae090093.json");
  const revision = JSON.parse(await readFile(path, "utf8")) as CanonicalRevision;
  assert.throws(() => assertCanonicalRevision({ ...revision, contentHash: `sha256:${"0".repeat(64)}` }), /content does not match/);
});

test("validate mode completes without any database access", async () => {
  let queried = false;
  const result = await synchronizeContentIndex(
    { mode: "validate", dataRoot },
    { execute: async () => {
      queried = true;
      throw new Error("database must not be queried");
    } },
  );
  assert.equal(queried, false);
  assert.equal(result.mode, "validate");
  assert.equal(result.runId, null);
});

test("an immediately repeated incremental snapshot performs zero mutations", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions);
  const sql: string[] = [];
  const result = await synchronizeContentIndex(
    { mode: "incremental", dataRoot },
    { execute: async (text) => {
      sql.push(text);
      return {
        rows: projected.map((entry) => ({
          entry_id: entry.entryId,
          revision_id: entry.revisionId,
          content_hash: entry.contentHash,
          file_id: entry.fileUuid,
        })),
        rowCount: projected.length,
        command: "SELECT",
        oid: 0,
        fields: [],
      };
    } },
  );
  assert.deepEqual(result.plan, { additions: [], updates: [], removals: [] });
  assert.equal(result.runId, null);
  assert.equal(sql.length, 1);
  assert.match(sql[0], /^SELECT entry_id/);
});

test("an interrupted staging run resumes from persisted entry checkpoints", async () => {
  let runId: string | null = null;
  const staged = new Set<string>();
  let stagingInserts = 0;
  let activationReached = false;
  const execute = async (text: string, params: readonly unknown[] = []) => {
    if (text.startsWith("SELECT entry_id, revision_id")) return { rows: [] } as never;
    if (text.startsWith("SELECT id FROM nfs_index_sync_runs")) {
      return { rows: runId ? [{ id: runId }] : [] } as never;
    }
    if (text.startsWith("INSERT INTO nfs_index_sync_runs")) {
      runId = String(params[0]);
      return { rows: [], rowCount: 1 } as never;
    }
    if (text.startsWith("SELECT entry_id FROM nfs_index_sync_staging")) {
      return { rows: [...staged].map((entry_id) => ({ entry_id })) } as never;
    }
    if (text.startsWith("INSERT INTO nfs_index_sync_staging")) {
      staged.add(String(params[1]));
      stagingInserts++;
      return { rows: [], rowCount: 1 } as never;
    }
    if (text.startsWith("SELECT count(*)")) return { rows: [{ count: String(staged.size) }] } as never;
    return { rows: [], rowCount: 1 } as never;
  };

  await assert.rejects(
    () => synchronizeContentIndex(
      { mode: "incremental", dataRoot },
      { execute, afterCheckpoint: () => { throw new Error("simulated interruption"); } },
    ),
    /simulated interruption/,
  );
  assert.equal(staged.size, 1);

  await assert.rejects(
    () => synchronizeContentIndex(
      { mode: "incremental", dataRoot },
      {
        execute,
        afterCheckpoint: () => { throw new Error("completed checkpoint must be skipped"); },
        transaction: async () => {
          activationReached = true;
          throw new Error("stop before test activation");
        },
      },
    ),
    /stop before test activation/,
  );
  assert.equal(stagingInserts, 1);
  assert.equal(activationReached, true);
});
