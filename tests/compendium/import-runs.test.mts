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
  job: "10000000-0000-4000-8000-000000000006",
  otherJob: "10000000-0000-4000-8000-000000000007",
  otherRun: "10000000-0000-4000-8000-000000000008",
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const runInput = {
  sourceId: ids.source,
  fileId: ids.file,
  importer: "core",
  importerVersion: "1",
  parserVersion: "2",
  promptVersion: "3",
  modelVersion: "4",
  inputSha256: hash("input"),
  actor: "test",
} as const;
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
  assert.match(statements[2], /ON CONFLICT DO NOTHING/);
  assert.match(statements[3], /\$3::uuid IS NOT NULL OR ingestion_job_id IS NOT DISTINCT FROM \$4/);
});

test("generation job omitted and matching-supplied requests resolve the same run", async () => {
  const insertedJobs: unknown[] = [];
  let insertCount = 0;
  let fallbackCount = 0;
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("SELECT id FROM files")) return { rows: [{ id: ids.file }] } as never;
      if (sql.includes("FROM ingestion_generations")) return { rows: [{ ingestion_job_id: ids.job }] } as never;
      if (sql.includes("FROM ingestion_jobs")) return { rows: [{ id: ids.job }] } as never;
      if (sql.includes("INSERT INTO compendium_import_runs")) {
        insertedJobs.push(values[3]);
        insertCount++;
        return { rows: insertCount === 1 ? [{ ...runRow, ingestion_job_id: ids.job }] : [] } as never;
      }
      if (sql.includes("FROM compendium_import_runs")) {
        fallbackCount++;
        return { rows: [{ ...runRow, ingestion_job_id: ids.job }] } as never;
      }
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  const omitted = await service.createRun({ ...runInput, generationId: ids.generation });
  const supplied = await service.createRun({ ...runInput, generationId: ids.generation, ingestionJobId: ids.job });
  assert.equal(omitted.id, supplied.id);
  assert.deepEqual(insertedJobs, [ids.job, ids.job]);
  assert.equal(fallbackCount, 1);
});

test("generation requests reject a supplied job that does not own the generation", async () => {
  const statements: string[] = [];
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("SELECT id FROM files")) return { rows: [{ id: ids.file }] } as never;
      if (sql.includes("FROM ingestion_generations")) return { rows: [{ ingestion_job_id: ids.job }] } as never;
      throw new Error("job lookup and insert must not run");
    },
  }));
  await assert.rejects(
    service.createRun({ ...runInput, generationId: ids.generation, ingestionJobId: ids.otherJob }),
    /generation does not belong to the requested ingestion job/,
  );
  assert.equal(statements.length, 2);
});

test("job-only identity is idempotent for the same job", async () => {
  let insertCount = 0;
  let fallbackSql = "";
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string) {
      if (sql.includes("SELECT id FROM files")) return { rows: [{ id: ids.file }] } as never;
      if (sql.includes("FROM ingestion_jobs")) return { rows: [{ id: ids.job }] } as never;
      if (sql.includes("INSERT INTO compendium_import_runs")) {
        insertCount++;
        return { rows: insertCount === 1 ? [{ ...runRow, generation_id: null, ingestion_job_id: ids.job }] : [] } as never;
      }
      if (sql.includes("FROM compendium_import_runs")) {
        fallbackSql = sql;
        return { rows: [{ ...runRow, generation_id: null, ingestion_job_id: ids.job }] } as never;
      }
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  const first = await service.createRun({ ...runInput, ingestionJobId: ids.job });
  const second = await service.createRun({ ...runInput, ingestionJobId: ids.job });
  assert.equal(first.id, second.id);
  assert.match(fallbackSql, /\$3::uuid IS NOT NULL OR ingestion_job_id IS NOT DISTINCT FROM \$4/);
});

test("job-only identity keeps different jobs distinct", async () => {
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("SELECT id FROM files")) return { rows: [{ id: ids.file }] } as never;
      if (sql.includes("FROM ingestion_jobs")) return { rows: [{ id: values[0] }] } as never;
      if (sql.includes("INSERT INTO compendium_import_runs")) return {
        rows: [{ ...runRow, id: values[3] === ids.job ? ids.run : ids.otherRun, generation_id: null, ingestion_job_id: values[3] }],
      } as never;
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  const first = await service.createRun({ ...runInput, ingestionJobId: ids.job });
  const second = await service.createRun({ ...runInput, ingestionJobId: ids.otherJob });
  assert.notEqual(first.id, second.id);
});

test("generation-less identity compares absent jobs null-safely", async () => {
  let insertCount = 0;
  let fallbackValues: unknown[] = [];
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("SELECT id FROM files")) return { rows: [{ id: ids.file }] } as never;
      if (sql.includes("INSERT INTO compendium_import_runs")) {
        insertCount++;
        return { rows: insertCount === 1 ? [{ ...runRow, generation_id: null, ingestion_job_id: null }] : [] } as never;
      }
      if (sql.includes("FROM compendium_import_runs")) {
        fallbackValues = values;
        return { rows: [{ ...runRow, generation_id: null, ingestion_job_id: null }] } as never;
      }
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  const first = await service.createRun(runInput);
  const second = await service.createRun(runInput);
  assert.equal(first.id, second.id);
  assert.equal(fallbackValues[2], null);
  assert.equal(fallbackValues[3], null);
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
  let candidateInsertSql = "";
  let replayLookup: { sql: string; values: unknown[] } | null = null;
  const service = new CompendiumImportRunService(async (callback) => callback({
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("FROM compendium_import_runs") && sql.includes("FOR UPDATE")) return { rows: [runRow] } as never;
      if (sql.includes("FROM compendium_import_occurrences") && sql.includes("ORDER BY occurrence_index")) {
        return { rows: [0, 1, 2, 3, 4, 5].map((index) => occurrenceRow(index)) } as never;
      }
      if (sql.includes("DISTINCT ON (candidate.entry_type, candidate.candidate_key)")) return { rows: [
        { id: "old-a", candidate_key: "a", entry_type: "spell", diff_status: "new", content: { name: "same" }, content_sha256: sameHash },
        { id: "old-b", candidate_key: "b", entry_type: "spell", diff_status: "new", content: { name: "old" }, content_sha256: hash('{"name":"old"}') },
        { id: "old-c", candidate_key: "c", entry_type: "spell", diff_status: "new", content: { name: "missing" }, content_sha256: hash('{"name":"missing"}') },
        { id: "old-item-c", candidate_key: "c", entry_type: "item", diff_status: "new", content: { name: "missing item" }, content_sha256: hash('{"name":"missing item"}') },
      ] } as never;
      if (sql.includes("INSERT INTO compendium_import_candidates")) {
        candidateInsertSql = sql;
        const row = {
          id: `new-${inserted.length}`, import_run_id: values[0], source_id: values[1], file_id: values[2], generation_id: values[3],
          occurrence_id: values[4], previous_candidate_id: values[5], candidate_order: values[6], candidate_key: values[7],
          entry_type: values[8], diff_status: values[9], content: JSON.parse(values[10] as string), content_sha256: values[11], invalid_reason: values[12],
          created_at: "2026-08-06T00:00:00.000Z",
        };
        inserted.push(row);
        return { rows: values[8] === "equipment" ? [] : [row] } as never;
      }
      if (sql.includes("entry_type IS NOT DISTINCT FROM")) {
        replayLookup = { sql, values };
        return { rows: [inserted.find((candidate) => candidate.entry_type === values[1] && candidate.candidate_key === values[2])] } as never;
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
    { occurrenceIndex: 4, candidateKey: "b", entryType: "equipment", content: { name: "same key, different type" } },
    { occurrenceIndex: 5, candidateKey: "en-starter", entryType: "guide", content: { review: { status: "pending" } } },
  ], "worker");
  assert.deepEqual(result.map(({ diffStatus }) => diffStatus).sort(), ["changed", "duplicate", "invalid", "missing", "missing", "new", "new", "unchanged"]);
  assert.equal(inserted.find((candidate) => candidate.entry_type === "guide")?.invalid_reason, null);
  const missing = inserted.filter((candidate) => candidate.diff_status === "missing");
  assert.deepEqual(missing.map((candidate) => candidate.entry_type).sort(), ["item", "spell"]);
  assert.ok(missing.every((candidate) => candidate.candidate_key === "c" && candidate.occurrence_id === null));
  assert.match(candidateInsertSql, /ON CONFLICT \(import_run_id, entry_type, candidate_key, occurrence_id\) DO NOTHING/);
  assert.match(replayLookup!.sql, /entry_type IS NOT DISTINCT FROM \$2[\s\S]*candidate_key = \$3[\s\S]*occurrence_id IS NOT DISTINCT FROM \$4/);
  assert.deepEqual(replayLookup!.values.slice(1), ["equipment", "b", "occurrence-4"]);
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
