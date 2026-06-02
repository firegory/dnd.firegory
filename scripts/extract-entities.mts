import { query } from "../src/server/db/client.ts";
import { runEntityExtraction } from "../src/server/entities/actions.ts";
import { runPipeline } from "../src/worker/ingestion/pipeline.ts";
import process from "node:process";

const sourceId = process.argv[2];
const userId = "31da5bd9-558d-4816-993f-3779582a86e4";
if (!sourceId) {
  console.error("Usage: node --experimental-strip-types scripts/extract-entities.mts <source_id>");
  process.exit(1);
}

console.log(`[extract] Source: ${sourceId}`);

const files = await query<{ id: string; storage_path: string }>(
  "SELECT id, storage_path FROM files WHERE source_id = $1 AND deleted_at IS NULL",
  [sourceId],
);

if (files.rows.length === 0) {
  console.error("[extract] No files found for source.");
  process.exit(1);
}

for (const file of files.rows) {
  const chunkCheck = await query<{ cnt: string }>(
    "SELECT COUNT(*)::text AS cnt FROM chunks WHERE file_id = $1",
    [file.id],
  );
  const chunkCount = parseInt(chunkCheck.rows[0].cnt, 10);

  if (chunkCount === 0) {
    const pipelineJob = await query<{ id: string }>(
      `INSERT INTO ingestion_jobs (kind, source_id, file_id, status, metadata, queue_id, requested_by_user_id)
       VALUES ('reprocess', $1, $2, 'processing', '{}', gen_random_uuid()::text, $3)
       RETURNING id`,
      [sourceId, file.id, userId],
    );
    const pipelineJobId = pipelineJob.rows[0].id;
    console.log(`[extract] Running pipeline for file ${file.id} (job ${pipelineJobId})...`);
    try {
      const result = await runPipeline({
        jobId: pipelineJobId,
        sourceId,
        fileId: file.id,
        originalPdfPath: file.storage_path,
      });
      console.log(`[extract] Pipeline done: ${result.chunksPersisted} chunks, ${result.pagesPersisted} pages`);
      await query("UPDATE ingestion_jobs SET status = 'succeeded', progress = 100 WHERE id = $1", [pipelineJobId]);
    } catch (err) {
      console.error("[extract] Pipeline failed:", err instanceof Error ? err.message : err);
      await query("UPDATE ingestion_jobs SET status = 'failed' WHERE id = $1", [pipelineJobId]);
      process.exit(1);
    }
  } else {
    console.log(`[extract] File already has ${chunkCount} chunks, skipping pipeline.`);
  }
}

const insertResult = await query<{ id: string }>(
  `INSERT INTO ingestion_jobs (kind, source_id, status, metadata, queue_id, requested_by_user_id)
   VALUES ('reprocess', $1, 'queued', '{"kind":"entity_extraction"}', gen_random_uuid()::text, $2)
   RETURNING id`,
  [sourceId, userId],
);
const jobId = insertResult.rows[0].id;
console.log(`[extract] Created job: ${jobId}`);

try {
  await runEntityExtraction(jobId);
  console.log("[extract] Entity extraction complete.");
} catch (err) {
  console.error("[extract] Extraction failed:", err instanceof Error ? err.message : err);
  try {
    await query("UPDATE ingestion_jobs SET status = 'failed', error_summary = $1 WHERE id = $2 AND status IN ('queued', 'processing')", [err instanceof Error ? err.message : String(err), jobId]);
  } catch {}
  process.exit(1);
}

process.exit(0);
