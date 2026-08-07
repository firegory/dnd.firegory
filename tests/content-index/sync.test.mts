import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { CanonicalRevision } from "../../src/server/content-storage/repository.ts";
import { assertCanonicalRevision, loadResolvedCanonicalRevisions } from "../../src/server/content-storage/validation.ts";
import {
  buildSyncPlan,
  claimContentIndexRun,
  heartbeatContentIndexRun,
  reconcileManagedProjectionRows,
  synchronizeContentIndex,
} from "../../src/server/content-index/sync.ts";
import {
  CONTENT_INDEX_PROJECTOR_VERSION,
  deterministicUuid,
  entryProjectionHash,
  projectCanonicalRevisions,
  projectionHash,
} from "../../src/server/content-index/projection.ts";
import { mapSearchChunk } from "../../src/server/search/map-chunk.ts";

const dataRoot = resolve("content-repository");

test("canonical projection deterministically rebuilds entries, pages, and chunks without embeddings", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const first = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
  const second = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);

  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].entryType, "action");
  assert.equal(first[0].pages[0].pageNumber, 72);
  assert.equal(first[0].pages[0].text, "When you take the Dash action, you gain extra movement for the current turn.");
  assert.equal(first[0].pages[0].citations[0].section, "Actions in Combat: Dash");
  assert.equal(first[0].file.byteSize, 144);
  assert.equal(first[0].chunks.length, 2);
  assert.equal(first[0].chunks[0].pageNumber, 72);
  assert.equal(first[0].chunks[0].sectionHeading, "Actions in Combat: Dash");
  assert.equal(first[0].chunks[0].quoteText, first[0].pages[0].citations[0].quote);
  assert.equal(first[0].chunks[0].textSpanStart, 0);
  assert.equal(first[0].chunks[0].textSpanEnd, 76);
  assert.equal(first[0].chunks[1].pageNumber, null);
  assert.equal("embedding" in first[0].chunks[0], false);
  assert.equal(first[0].chunks.map((chunk) => chunk.text).join(""), first[0].plainText);
});

test("projection and manifest identities are stable and content-derived", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
  const hash = projectionHash(resolved.manifest.repositoryId, projected);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hash, projectionHash(resolved.manifest.repositoryId, projected));
  assert.match(entryProjectionHash(projected[0]), /^sha256:[0-9a-f]{64}$/);
  assert.equal(CONTENT_INDEX_PROJECTOR_VERSION, 4);
  const changedSize = structuredClone(projected);
  (changedSize[0].file as { byteSize: number }).byteSize++;
  assert.notEqual(hash, projectionHash(resolved.manifest.repositoryId, changedSize));
  const changedCitation = structuredClone(projected);
  (changedCitation[0].pages[0].citations[0] as { section: string }).section = "Changed section";
  assert.notEqual(hash, projectionHash(resolved.manifest.repositoryId, changedCitation));
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
  assert.deepEqual(buildSyncPlan("incremental", [{ ...desired[2], generationId: "new-generation" }], [{
    ...active[2], generation_id: "old-generation",
  }]).updates, ["same"]);
});

test("corrupt canonical hashes are rejected before projection", async () => {
  const path = resolve(dataRoot, "compendium/dash/revisions/rev-42eaa0fa9421910cca58164912c48bd4bf8b39fbba226808f920e35dae090093.json");
  const revision = JSON.parse(await readFile(path, "utf8")) as CanonicalRevision;
  assert.throws(() => assertCanonicalRevision({ ...revision, contentHash: `sha256:${"0".repeat(64)}` }), /content does not match/);
});

test("projector explicitly rejects revisions citing multiple source files", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const revision = structuredClone(resolved.revisions[0]) as CanonicalRevision & {
    citations: Array<Record<string, unknown>>;
  };
  revision.citations.push({ ...revision.citations[0], citationId: "other-citation", fileId: "other-file" });
  assert.throws(
    () => projectCanonicalRevisions(resolved.manifest.repositoryId, [revision], resolved.sourceFiles),
    /cites multiple source files/,
  );
});

test("projector rejects overlapping citations with ambiguous retrieval provenance", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const revision = structuredClone(resolved.revisions[0]) as CanonicalRevision & {
    citations: Array<Record<string, unknown>>;
  };
  revision.citations.push({
    ...revision.citations[0],
    citationId: "ambiguous-citation",
    section: "Different section",
  });
  assert.throws(
    () => projectCanonicalRevisions(resolved.manifest.repositoryId, [revision], resolved.sourceFiles),
    /ambiguous page or section provenance/,
  );
});

test("Dash citation provenance reaches normal search result columns", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
  const citedChunk = projected[0].chunks.find((chunk) => chunk.pageNumber === 72)!;
  const result = mapSearchChunk({
    id: citedChunk.id,
    source_id: projected[0].sourceUuid,
    file_id: projected[0].fileUuid,
    text: citedChunk.text,
    quote_text: citedChunk.quoteText,
    section_heading: citedChunk.sectionHeading,
    page_number: citedChunk.pageNumber,
    title: projected[0].source.title,
    category: projected[0].source.category,
    edition: projected[0].source.edition,
    language: projected[0].source.language,
    access_tier: projected[0].source.accessTier,
  });
  assert.equal(result.pageNumber, 72);
  assert.equal(result.sectionHeading, "Actions in Combat: Dash");
  assert.equal(result.quoteText, "When you take the Dash action, you gain extra movement for the current turn.");
  const service = await readFile(resolve("src/server/search/service.ts"), "utf8");
  assert.match(service, /c\.section_heading, c\.page_number/);
  assert.match(service, /chunkResult\.rows\.map\(mapSearchChunk\)/);
});

test("projection reconciliation deletes only surplus managed documents, pages, and chunks", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  await reconcileManagedProjectionRows({
    query: async (text, params = []) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 0, command: "DELETE", oid: 0, fields: [] };
    },
  }, resolved.manifest.repositoryId, projected);

  assert.equal(calls.length, 4);
  assert.match(calls[0].text, /^SELECT/);
  assert.match(calls[0].text, /unmanaged_collision/);
  assert.match(calls[1].text, /^DELETE FROM chunks/);
  assert.match(calls[2].text, /^DELETE FROM pages/);
  assert.match(calls[3].text, /^DELETE FROM documents/);
  for (const call of calls.slice(1)) {
    assert.match(call.text, /metadata->>'managedBy' = 'nfs-content-index'/);
    assert.match(call.text, /NOT \(id = ANY\(\$2::uuid\[\]\)\)/);
    assert.equal(call.params[0], projected[0].generationId);
  }
  assert.deepEqual(calls[1].params[1], projected[0].chunks.map((chunk) => chunk.id));
  assert.deepEqual(calls[3].params[1], [projected[0].documentId]);
});

test("projection reconciliation refuses deterministic collisions with unmanaged rows", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
  let queries = 0;
  await assert.rejects(
    () => reconcileManagedProjectionRows({
      query: async () => {
        queries++;
        return { rows: [{ unmanaged_collision: true }], rowCount: 1, command: "SELECT", oid: 0, fields: [] } as never;
      },
    }, resolved.manifest.repositoryId, projected),
    /conflicts with unmanaged index rows/,
  );
  assert.equal(queries, 1);
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
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
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
          generation_id: entry.generationId,
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

test("dry-run with planned changes is database-pure", async () => {
  const sql: string[] = [];
  const result = await synchronizeContentIndex(
    { mode: "clean", dryRun: true, dataRoot },
    {
      execute: async (text) => {
        sql.push(text);
        return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      },
      transaction: async () => { throw new Error("dry-run must not start a transaction"); },
    },
  );
  assert.deepEqual(result.plan.additions, ["dash"]);
  assert.equal(result.runId, null);
  assert.equal(sql.length, 1);
  assert.match(sql[0], /^SELECT entry_id/);
});

test("run leases resume matching owners, reject live owners, and supersede only stale runs", async () => {
  type Run = {
    id: string;
    repository: string;
    projectionHash: string;
    mode: "incremental" | "clean";
    owner: string;
    expiresAt: number;
    status: "staging" | "failed" | "succeeded";
  };
  const runs: Run[] = [];
  let now = 1_000;
  const execute = async (text: string, params: readonly unknown[] = []) => {
    assert.match(text, /^SELECT run_id, resumed FROM claim_nfs_index_sync_run/);
    const repository = String(params[1]);
    const mode = params[2] as Run["mode"];
    const projectionHashValue = String(params[3]);
    const owner = String(params[9]);
    const leaseSeconds = Number(params[10]);
    const active = runs.find((run) => run.repository === repository && run.status === "staging");
    if (active) {
      if (active.owner === owner && active.projectionHash === projectionHashValue
        && active.mode === mode && active.expiresAt > now) {
        active.expiresAt = now + leaseSeconds;
        return { rows: [{ run_id: active.id, resumed: true }] } as never;
      }
      if (active.expiresAt > now) throw new Error("another live NFS index sync owner holds repository");
      if (active.projectionHash === projectionHashValue && active.mode === mode) {
        active.owner = owner;
        active.expiresAt = now + leaseSeconds;
        return { rows: [{ run_id: active.id, resumed: true }] } as never;
      }
      active.status = "failed";
    }
    const created: Run = {
      id: String(params[0]), repository, mode, projectionHash: projectionHashValue,
      owner, expiresAt: now + leaseSeconds, status: "staging",
    };
    runs.push(created);
    return { rows: [{ run_id: created.id, resumed: false }] } as never;
  };
  const input = {
    repositoryId: "repository",
    manifestHash: `sha256:${"a".repeat(64)}`,
    generation: null,
    mode: "incremental" as const,
    plan: { additions: ["dash"], updates: [], removals: [] },
    ownerToken: "11111111-1111-4111-8111-111111111111",
    leaseSeconds: 60,
  };
  const first = await claimContentIndexRun(execute, input);
  const second = await claimContentIndexRun(execute, input);
  assert.equal(first.id, second.id);
  assert.deepEqual([first.resumed, second.resumed], [false, true]);
  await assert.rejects(
    () => claimContentIndexRun(execute, {
      ...input,
      manifestHash: `sha256:${"b".repeat(64)}`,
      ownerToken: "22222222-2222-4222-8222-222222222222",
    }),
    /live NFS index sync owner/,
  );
  now += 61;
  const recovered = await claimContentIndexRun(execute, {
    ...input,
    ownerToken: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.resumed, true);
  now += 61;
  const takeover = await claimContentIndexRun(execute, {
    ...input,
    manifestHash: `sha256:${"b".repeat(64)}`,
    ownerToken: "33333333-3333-4333-8333-333333333333",
  });
  assert.notEqual(takeover.id, first.id);
  assert.equal(runs.find((run) => run.id === first.id)?.status, "failed");
  const succeeded = runs.find((run) => run.id === takeover.id)!;
  succeeded.status = "succeeded";
  const afterSuccess = await claimContentIndexRun(execute, {
    ...input,
    manifestHash: `sha256:${"c".repeat(64)}`,
    ownerToken: "44444444-4444-4444-8444-444444444444",
  });
  assert.notEqual(afterSuccess.id, takeover.id);
  assert.equal(succeeded.status, "succeeded");
});

test("heartbeat cannot revive an expired or differently owned run", async () => {
  let params: readonly unknown[] = [];
  await assert.rejects(
    () => heartbeatContentIndexRun(async (text, values = []) => {
      assert.match(text, /owner_token = \$2/);
      assert.match(text, /lease_expires_at > clock_timestamp\(\)/);
      params = values;
      return { rows: [] } as never;
    }, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 30),
    /not owned or has expired/,
  );
  assert.deepEqual(params, [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    30,
  ]);
});

test("an interrupted staging run resumes from persisted entry checkpoints", async () => {
  let runId: string | null = null;
  const staged = new Map<string, { payload_hash: string; projector_version: number }>();
  let stagingInserts = 0;
  let activationReached = false;
  const execute = async (text: string, params: readonly unknown[] = []) => {
    if (text.startsWith("SELECT entry_id, revision_id")) return { rows: [] } as never;
    if (text.startsWith("SELECT run_id, resumed FROM claim_nfs_index_sync_run")) {
      const resumed = runId !== null;
      runId ??= String(params[0]);
      return { rows: [{ run_id: runId, resumed }] } as never;
    }
    if (text.startsWith("UPDATE nfs_index_sync_runs\n     SET heartbeat_at")) return { rows: [{ id: runId }] } as never;
    if (text.startsWith("SELECT entry_id, payload_hash")) {
      return { rows: [...staged].map(([entry_id, checkpoint]) => ({ entry_id, ...checkpoint })) } as never;
    }
    if (text.startsWith("INSERT INTO nfs_index_sync_staging")) {
      staged.set(String(params[1]), {
        projector_version: Number(params[4]),
        payload_hash: String(params[5]),
      });
      stagingInserts++;
      return { rows: [], rowCount: 1 } as never;
    }
    if (text.startsWith("SELECT count(*)")) return { rows: [{ count: String(staged.size) }] } as never;
    return { rows: [], rowCount: 1 } as never;
  };

  await assert.rejects(
    () => synchronizeContentIndex(
      { mode: "incremental", dataRoot },
      {
        execute,
        ownerToken: "11111111-1111-4111-8111-111111111111",
        afterCheckpoint: () => { throw new Error("simulated interruption"); },
      },
    ),
    /simulated interruption/,
  );
  assert.equal(staged.size, 1);

  await assert.rejects(
    () => synchronizeContentIndex(
      { mode: "incremental", dataRoot },
      {
        execute,
        ownerToken: "11111111-1111-4111-8111-111111111111",
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

test("resume rejects a corrupted persisted projection checkpoint", async () => {
  let runId: string | null = null;
  const staged = new Map<string, { payload_hash: string; projector_version: number }>();
  const execute = async (text: string, params: readonly unknown[] = []) => {
    if (text.startsWith("SELECT entry_id, revision_id")) return { rows: [] } as never;
    if (text.startsWith("SELECT run_id, resumed FROM claim_nfs_index_sync_run")) {
      const resumed = runId !== null;
      runId ??= String(params[0]);
      return { rows: [{ run_id: runId, resumed }] } as never;
    }
    if (text.startsWith("UPDATE nfs_index_sync_runs\n     SET heartbeat_at")) return { rows: [{ id: runId }] } as never;
    if (text.startsWith("SELECT entry_id, payload_hash")) {
      return { rows: [...staged].map(([entry_id, checkpoint]) => ({ entry_id, ...checkpoint })) } as never;
    }
    if (text.startsWith("INSERT INTO nfs_index_sync_staging")) {
      staged.set(String(params[1]), { projector_version: Number(params[4]), payload_hash: String(params[5]) });
      return { rows: [], rowCount: 1 } as never;
    }
    if (text.startsWith("SELECT count(*)")) return { rows: [{ count: String(staged.size) }] } as never;
    return { rows: [], rowCount: 1 } as never;
  };
  await assert.rejects(
    () => synchronizeContentIndex(
      { mode: "incremental", dataRoot },
      {
        execute,
        ownerToken: "11111111-1111-4111-8111-111111111111",
        afterCheckpoint: () => { throw new Error("interrupt"); },
      },
    ),
    /interrupt/,
  );
  const entryId = [...staged.keys()][0];
  staged.set(entryId, { projector_version: CONTENT_INDEX_PROJECTOR_VERSION, payload_hash: `sha256:${"0".repeat(64)}` });
  await assert.rejects(
    () => synchronizeContentIndex(
      { mode: "incremental", dataRoot },
      { execute, ownerToken: "11111111-1111-4111-8111-111111111111" },
    ),
    /does not match the freshly validated projection/,
  );
});
