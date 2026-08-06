import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { markJobProcessing } from "../../src/server/ingestion/storage.ts";

const storage = await readFile("src/server/ingestion/storage.ts", "utf8");
const pipeline = await readFile("src/worker/ingestion/pipeline.ts", "utf8");
const actions = await readFile("src/server/ingestion/actions.ts", "utf8");

test("job claim is one atomic queued update with RETURNING", () => {
  const claim = storage.slice(storage.indexOf("export async function markJobProcessing"), storage.indexOf("Marks an ingestion job as succeeded"));
  assert.match(claim, /UPDATE ingestion_jobs[\s\S]*status = 'processing'[\s\S]*status = 'queued'[\s\S]*RETURNING id/);
  assert.match(claim, /return result\.rows\.length === 1/);
  assert.match(pipeline, /if \(!await markJobProcessing\(jobId\)\)/);
  assert.ok(
    pipeline.indexOf("markJobProcessing(jobId)")
      < pipeline.indexOf("const generation = await createStagedGeneration"),
  );
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
