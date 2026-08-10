import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { markJobProcessing } from "../../src/server/ingestion/storage.ts";
import { runPipeline } from "../../src/worker/ingestion/pipeline.ts";

const actions = await readFile("src/server/ingestion/actions.ts", "utf8");

test("pipeline stops before staging when its atomic job claim loses", async () => {
  let staged = false;
  await assert.rejects(runPipeline({
    jobId: "job-1", sourceId: "source-1", fileId: "file-1", originalPdfPath: "unused.pdf",
  }, {
    getIngestionJob: async () => ({ id: "job-1" } as never),
    markJobProcessing: async () => false,
    createStagedGeneration: async () => {
      staged = true;
      throw new Error("must not stage");
    },
  }), /already claimed/);
  assert.equal(staged, false);
});

test("two workers cannot both claim the same queued job", async () => {
  let status = "queued";
  const execute = (async () => {
    if (status !== "queued") return { rows: [], rowCount: 0 };
    status = "processing";
    return { rows: [{ id: "job-1" }], rowCount: 1 };
  }) as never;
  const claims = await Promise.all([
    markJobProcessing("job-1", execute),
    markJobProcessing("job-1", execute),
  ]);
  assert.deepEqual(claims.sort(), [false, true]);
});

test("retry and reprocess lock the stable file before replacement checks", () => {
  const retry = actions.slice(actions.indexOf("export async function retryFailedJob"), actions.indexOf("// Reprocess"));
  const reprocess = actions.slice(actions.indexOf("export async function reprocessSource"), actions.indexOf("function replacementConflict"));
  for (const action of [retry, reprocess]) {
    const lock = action.indexOf("FROM files WHERE id = $1 FOR UPDATE");
    const activeCheck = action.indexOf("status IN ('queued', 'processing')");
    const insert = action.indexOf("createIngestionJob");
    assert.ok(lock >= 0 && lock < activeCheck && activeCheck < insert);
  }
  assert.match(actions, /error\.constraint === "ingestion_jobs_one_active_file_idx"/);
});
