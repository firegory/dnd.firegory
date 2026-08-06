import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateGeneration,
  cleanupStaleGenerations,
  createStagedGeneration,
  discardStagedGeneration,
} from "../../src/server/ingestion/generations.ts";

const generationRow = {
  id: "generation-new",
  source_id: "source-1",
  file_id: "file-1",
  ingestion_job_id: "job-1",
  status: "staged" as const,
  artifacts_root: "/processed/file-1/job-1",
};

test("staging is idempotent for the same ingestion job", async () => {
  const statements: string[] = [];
  const db = {
    async query(sql: string) {
      statements.push(sql);
      return { rows: statements.length === 1 ? [] : [generationRow] } as never;
    },
  };

  const generation = await createStagedGeneration({
    sourceId: "source-1",
    fileId: "file-1",
    jobId: "job-1",
    artifactsRoot: "/processed/file-1/job-1",
    client: db,
  });

  assert.equal(generation.id, "generation-new");
  assert.match(statements[0], /ON CONFLICT \(ingestion_job_id\) DO NOTHING/);
  assert.match(statements[1], /WHERE ingestion_job_id = \$1/);
});

test("activation archives and switches generations entirely inside one transaction", async () => {
  const statements: string[] = [];
  let transactionCalls = 0;
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("JOIN ingestion_jobs")) {
        return { rows: [{ ...generationRow, job_status: "processing" }] } as never;
      }
      if (sql.includes("SELECT active_generation_id")) {
        return { rows: [{ active_generation_id: "generation-old" }] } as never;
      }
      return { rows: [], rowCount: 1 } as never;
    },
  };

  await activateGeneration("generation-new", async (callback) => {
    transactionCalls++;
    return callback(client as never);
  });

  assert.equal(transactionCalls, 1);
  assert.equal(statements.length, 6);
  assert.match(statements[2], /status = 'archived'/);
  assert.match(statements[3], /status = 'active'/);
  assert.match(statements[4], /active_generation_id = \$2, processed_artifacts_root = \$3/);
  assert.match(statements[5], /status = 'succeeded'/);
});

test("cancelled jobs cannot activate a staged replacement", async () => {
  const client = {
    async query() {
      return { rows: [{ ...generationRow, job_status: "cancelled" }] } as never;
    },
  };
  await assert.rejects(
    activateGeneration("generation-new", async (callback) => callback(client as never)),
    /not staged for a processing job/,
  );
});

test("failed staging cleanup deletes only staged rows and generation artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ingestion-generation-"));
  const artifacts = join(root, "job-1");
  await writeFile(artifacts, "staged");
  let statement = "";

  try {
    await discardStagedGeneration("generation-new", artifacts, {
      execute: (async (sql: string) => {
        statement = sql;
        return { rows: [], rowCount: 1 } as never;
      }) as never,
    });
    assert.match(statement, /DELETE FROM ingestion_generations WHERE id = \$1 AND status = 'staged'/);
    await assert.rejects(readFile(artifacts), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry cleanup removes only terminal staged generations", async () => {
  const removed: string[] = [];
  let statement = "";
  const count = await cleanupStaleGenerations("file-1", "job-current", {
    execute: (async (sql: string) => {
      statement = sql;
      return {
        rows: [
          { artifacts_root: "/processed/file-1/failed" },
          { artifacts_root: "/processed/file-1/cancelled" },
        ],
        rowCount: 2,
      } as never;
    }) as never,
    remove: (async (path: string) => {
      removed.push(path);
    }) as never,
  });

  assert.equal(count, 2);
  assert.match(statement, /g\.status = 'staged'/);
  assert.match(statement, /j\.status IN \('failed', 'cancelled'\)/);
  assert.match(statement, /g\.ingestion_job_id <> \$2/);
  assert.doesNotMatch(statement, /status = 'active'/);
  assert.deepEqual(removed, ["/processed/file-1/failed", "/processed/file-1/cancelled"]);
});
