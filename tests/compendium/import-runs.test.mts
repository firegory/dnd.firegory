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
const occurrenceRow = (occurrenceIndex: number, fingerprintSha256 = hash(`occurrence-${occurrenceIndex}`)) => ({
  id: `occurrence-${occurrenceIndex}`,
  import_run_id: ids.run,
  source_id: ids.source,
  file_id: ids.file,
  generation_id: ids.generation,
  chunk_id: null,
  occurrence_index: occurrenceIndex,
  locator: `page:${occurrenceIndex + 1}`,
  fingerprint_sha256: fingerprintSha256,
  created_at: "2026-08-06T00:00:00.000Z",
});

test("identical run creation resolves the existing durable run", async () => {
  const statements: string[] = [];
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("SELECT id FROM files")) return { rows: [{ id: ids.file }] } as never;
      if (sql.includes("SELECT ingestion_job_id FROM ingestion_generations")) return { rows: [{ ingestion_job_id: null }] } as never;
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
  assert.match(statements[0], /FROM files[\s\S]*FOR SHARE/);
  assert.match(statements[1], /FROM ingestion_generations[\s\S]*FOR SHARE/);
  assert.match(statements[2], /ON CONFLICT ON CONSTRAINT compendium_import_runs_identity_unique DO NOTHING/);
  assert.match(statements[3], /ingestion_job_id IS NOT DISTINCT FROM \$4/);
});

test("run ownership is fully validated before insert or conflict fallback", async () => {
  const statements: string[] = [];
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("SELECT id FROM files")) return { rows: [{ id: ids.file }] } as never;
      if (sql.includes("FROM ingestion_generations")) return { rows: [] } as never;
      throw new Error("insert/fallback must not run");
    },
  }));
  await assert.rejects(service.createRun({
    sourceId: ids.source, fileId: ids.file, generationId: ids.generation,
    importer: "core", importerVersion: "1", parserVersion: "2", promptVersion: "3", modelVersion: "4",
    inputSha256: hash("input"), actor: "test",
  }), /generation is outside/);
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
  let checkpointHash = "";
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string, values: unknown[] = []) {
      statements.push(sql);
      if (sql.includes("FROM compendium_import_runs") && sql.includes("FOR UPDATE")) return { rows: [runRow] } as never;
      if (sql.includes("INSERT INTO compendium_import_occurrences")) return { rows: [] } as never;
      if (sql.includes("FROM compendium_import_occurrences") && !sql.includes("count(*)")) return { rows: [{ ...occurrenceRow(0, fingerprint), locator: "page:1" }] } as never;
      if (sql.includes("INSERT INTO compendium_import_checkpoints")) {
        checkpointHash = values[2] as string;
        return { rows: [{ content_sha256: values[2], details: JSON.parse(values[3] as string) }] } as never;
      }
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  await service.recordOccurrences(ids.run, ids.lease, [{ occurrenceIndex: 0, locator: "page:1", fingerprintSha256: fingerprint }], "worker");
  assert.ok(statements.some((sql) => /ON CONFLICT \(import_run_id, occurrence_index\) DO NOTHING/.test(sql)));
  assert.ok(statements.some((sql) => sql.includes("checkpoint_key")));
  assert.notEqual(checkpointHash, fingerprint);
});

test("occurrences are rejected after the run advances to diffing", async () => {
  const statements: string[] = [];
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      return { rows: [{ ...runRow, checkpoint: "diffed" }] } as never;
    },
  }));
  await assert.rejects(service.recordOccurrences(ids.run, ids.lease, [], "worker"), /cannot be recorded after candidate diffing/);
  assert.equal(statements.length, 1);
});

test("candidate diff retains unchanged, changed, missing, duplicate, and invalid review rows", async () => {
  const sameHash = hash('{"name":"same"}');
  const inserted: Array<Record<string, unknown>> = [];
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("FROM compendium_import_runs") && sql.includes("FOR UPDATE")) return { rows: [runRow] } as never;
      if (sql.includes("FROM compendium_import_occurrences") && sql.includes("ORDER BY occurrence_index")) {
        return { rows: [0, 1, 2, 3].map((index) => occurrenceRow(index)) } as never;
      }
      if (sql.includes("DISTINCT ON (candidate.candidate_key)")) return { rows: [
        { id: "old-a", candidate_key: "a", entry_type: "spell", diff_status: "new", content: { name: "same" }, content_sha256: sameHash },
        { id: "old-b", candidate_key: "b", entry_type: "spell", diff_status: "new", content: { name: "old" }, content_sha256: hash('{"name":"old"}') },
        { id: "old-c", candidate_key: "c", entry_type: "spell", diff_status: "new", content: { name: "missing" }, content_sha256: hash('{"name":"missing"}') },
      ] } as never;
      if (sql.includes("INSERT INTO compendium_import_candidates")) {
        const row = {
          id: `new-${inserted.length}`, import_run_id: values[0], source_id: values[1], file_id: values[2], generation_id: values[3],
          occurrence_id: values[4], previous_candidate_id: values[5], candidate_order: values[6], candidate_key: values[7],
          entry_type: values[8], diff_status: values[9], content: JSON.parse(values[10] as string), content_sha256: values[11], invalid_reason: values[12],
          created_at: "2026-08-06T00:00:00.000Z",
        };
        inserted.push(row);
        return { rows: [row] } as never;
      }
      if (sql.includes("INSERT INTO compendium_import_checkpoints")) return { rows: [{ content_sha256: values[2], details: JSON.parse(values[3] as string) }] } as never;
      if (sql.includes("FROM compendium_import_candidates WHERE import_run_id") && sql.includes("ORDER BY candidate_order")) return { rows: inserted } as never;
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
      if (sql.includes("FROM compendium_import_occurrences")) return { rows: [] } as never;
      if (sql.includes("DISTINCT ON")) return { rows: [] } as never;
      if (sql.includes("FROM compendium_import_candidates")) return { rows: [] } as never;
      if (sql.includes("FROM compendium_import_checkpoints")) return {
        rows: [{ content_sha256: hash('{"candidates":[],"occurrences":[]}'), details: { candidateCount: 0, occurrenceCount: 0 } }],
      } as never;
      throw new Error(`unexpected query: ${sql}`);
    },
  }));
  assert.deepEqual(await service.computeCandidateDiff(ids.run, ids.lease, [], "worker"), []);
  assert.equal(statements.length, 4);
  assert.ok(!statements.some((sql) => sql.includes("INSERT INTO compendium_import_candidates")));
});

test("resume rejects a canonical diff checkpoint that omits persisted provenance", async () => {
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string) {
      if (sql.includes("FOR UPDATE")) return { rows: [{ ...runRow, checkpoint: "diffed" }] } as never;
      if (sql.includes("FROM compendium_import_occurrences")) return { rows: [] } as never;
      if (sql.includes("DISTINCT ON")) return { rows: [] } as never;
      if (sql.includes("FROM compendium_import_candidates")) return { rows: [] } as never;
      if (sql.includes("FROM compendium_import_checkpoints")) return {
        rows: [{ content_sha256: hash("incomplete"), details: { candidateCount: 0, occurrenceCount: 0 } }],
      } as never;
      return { rows: [] } as never;
    },
  }));
  await assert.rejects(service.computeCandidateDiff(ids.run, ids.lease, [], "worker"), /Checkpoint candidate-diff has different immutable content/);
});
