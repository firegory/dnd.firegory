import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CompendiumImportRunService, ImportRunConflictError } from "../../src/server/compendium/import-runs.ts";

const ids = {
  source: "10000000-0000-4000-8000-000000000001",
  file: "10000000-0000-4000-8000-000000000002",
  generation: "10000000-0000-4000-8000-000000000003",
  run: "10000000-0000-4000-8000-000000000004",
  lease: "10000000-0000-4000-8000-000000000005",
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const runRow = {
  id: ids.run,
  source_id: ids.source,
  file_id: ids.file,
  generation_id: ids.generation,
  status: "running" as const,
  checkpoint: "occurrences" as const,
  lease_token: ids.lease,
  lease_active: true,
};

test("identical run creation resolves the existing durable run", async () => {
  const statements: string[] = [];
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("INSERT INTO compendium_import_runs")) return { rows: [] } as never;
      return { rows: [{ ...runRow, status: "succeeded", checkpoint: "completed" }] } as never;
    },
  }));
  const result = await service.createRun({
    sourceId: ids.source, fileId: ids.file, generationId: ids.generation,
    importer: "core", importerVersion: "1", parserVersion: "2", promptVersion: "3", modelVersion: "4",
    inputSha256: hash("input"), actor: "test",
  });
  assert.equal(result.id, ids.run);
  assert.equal(result.status, "succeeded");
  assert.match(statements[0], /ON CONFLICT ON CONSTRAINT compendium_import_runs_identity_unique DO NOTHING/);
  assert.match(statements[0], /g\.file_id = f\.id AND g\.source_id = f\.source_id/);
  assert.equal(statements.length, 2);
});

test("an expired partial run is reclaimed while an active lease is rejected", async () => {
  const statements: string[] = [];
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("FOR UPDATE")) return { rows: [{ ...runRow, lease_active: false }] } as never;
      if (sql.includes("UPDATE compendium_import_runs")) return { rows: [runRow], rowCount: 1 } as never;
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  const claim = await service.claimRun(ids.run, "worker", 5_000);
  assert.equal(claim.leaseToken, ids.lease);
  assert.match(statements[1], /lease_token = gen_random_uuid\(\)/);
  assert.match(statements[1], /finished_at = NULL/);

  const busy = new CompendiumImportRunService(async (callback) => callback({
    async query() { return { rows: [{ ...runRow, lease_active: true }] } as never; },
  }));
  await assert.rejects(busy.claimRun(ids.run, "worker"), ImportRunConflictError);
});

test("occurrence replay keeps immutable completed work without duplicates", async () => {
  const fingerprint = hash("occurrence");
  const statements: string[] = [];
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("FROM compendium_import_runs") && sql.includes("FOR UPDATE")) return { rows: [runRow] } as never;
      if (sql.includes("INSERT INTO compendium_import_occurrences")) return { rows: [] } as never;
      if (sql.includes("SELECT chunk_id, locator")) return { rows: [{ chunk_id: null, locator: "page:1", fingerprint_sha256: fingerprint }] } as never;
      if (sql.includes("INSERT INTO compendium_import_checkpoints")) return { rows: [] } as never;
      if (sql.includes("SELECT content_sha256")) return { rows: [{ content_sha256: fingerprint }] } as never;
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  await service.recordOccurrences(ids.run, ids.lease, [{ occurrenceIndex: 0, locator: "page:1", fingerprintSha256: fingerprint }], "worker");
  assert.ok(statements.some((sql) => /ON CONFLICT \(import_run_id, occurrence_index\) DO NOTHING/.test(sql)));
  assert.ok(statements.some((sql) => sql.includes("checkpoint_key")));
});

test("candidate diff retains unchanged, changed, missing, duplicate, and invalid review rows", async () => {
  const sameHash = hash('{"name":"same"}');
  const inserted: Array<Record<string, unknown>> = [];
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("FROM compendium_import_runs") && sql.includes("FOR UPDATE")) return { rows: [runRow] } as never;
      if (sql.includes("FROM compendium_import_occurrences") && sql.includes("ORDER BY occurrence_index")) {
        return { rows: [0, 1, 2, 3].map((occurrence_index) => ({ id: `occurrence-${occurrence_index}`, occurrence_index })) } as never;
      }
      if (sql.includes("DISTINCT ON (candidate.candidate_key)")) return { rows: [
        { id: "old-a", candidate_key: "a", entry_type: "spell", diff_status: "new", content: { name: "same" }, content_sha256: sameHash },
        { id: "old-b", candidate_key: "b", entry_type: "spell", diff_status: "new", content: { name: "old" }, content_sha256: hash('{"name":"old"}') },
        { id: "old-c", candidate_key: "c", entry_type: "spell", diff_status: "new", content: { name: "missing" }, content_sha256: hash('{"name":"missing"}') },
      ] } as never;
      if (sql.includes("INSERT INTO compendium_import_candidates")) {
        const row = { id: `new-${inserted.length}`, candidate_key: values[6], entry_type: values[7], diff_status: values[8], content: JSON.parse(values[9] as string), content_sha256: values[10] };
        inserted.push(row);
        return { rows: [row] } as never;
      }
      if (sql.includes("INSERT INTO compendium_import_checkpoints")) return { rows: [{ content_sha256: values[2] }] } as never;
      if (sql.includes("FROM compendium_import_candidates WHERE import_run_id") && sql.includes("ORDER BY candidate_key")) return { rows: inserted } as never;
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  const result = await service.computeCandidateDiff(ids.run, ids.lease, [
    { occurrenceIndex: 0, candidateKey: "a", entryType: "spell", content: { name: "same" } },
    { occurrenceIndex: 1, candidateKey: "b", entryType: "spell", content: { name: "changed" } },
    { occurrenceIndex: 2, candidateKey: "b", entryType: "spell", content: { name: "duplicate" } },
    { occurrenceIndex: 3, candidateKey: null, entryType: null, content: { raw: "?" }, invalidReason: "parser rejected candidate" },
  ], "worker");
  assert.deepEqual(result.map(({ diffStatus }) => diffStatus).sort(), ["changed", "duplicate", "invalid", "missing", "unchanged"]);
  const missing = inserted.find((candidate) => candidate.diff_status === "missing")!;
  assert.equal(missing.candidate_key, "c");
  assert.equal((missing.content as { name: string }).name, "missing");
});

test("a persisted diff checkpoint resumes without recomputing candidates", async () => {
  const statements: string[] = [];
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("FOR UPDATE")) return { rows: [{ ...runRow, checkpoint: "diffed" }] } as never;
      if (sql.includes("ORDER BY candidate_key")) return { rows: [] } as never;
      throw new Error(`unexpected query: ${sql}`);
    },
  }));
  assert.deepEqual(await service.computeCandidateDiff(ids.run, ids.lease, [], "worker"), []);
  assert.equal(statements.length, 2);
  assert.ok(!statements.some((sql) => sql.includes("INSERT INTO compendium_import_candidates")));
});
