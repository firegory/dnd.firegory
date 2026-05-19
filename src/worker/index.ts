/**
 * Worker entrypoint for processing ingestion jobs from the Redis queue.
 *
 * Dequeues jobs, loads file/source metadata, and runs the full PDF
 * processing pipeline (normalize → extract → OCR → chunk → embed → persist).
 */

import { ensureRedisConnection, dequeueJob, getRedisClient } from "../server/ingestion/queue.ts";
import {
  getIngestionJob,
  markJobFailed,
} from "../server/ingestion/storage.ts";
import { runPipeline } from "./ingestion/pipeline.ts";
import { query } from "../server/db/client.ts";

const POLL_INTERVAL_SECONDS = 5;
const MAX_CONSECUTIVE_ERRORS = 10;

async function runWorker(): Promise<void> {
  console.log("[worker] Starting ingestion worker...");
  await ensureRedisConnection();
  console.log("[worker] Connected to Redis.");

  let consecutiveErrors = 0;

  while (consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
    try {
      const message = await dequeueJob(POLL_INTERVAL_SECONDS);
      if (!message) continue;

      console.log(`[worker] Picked up job: ${message.jobId}`);
      const job = await getIngestionJob(message.jobId);

      if (!job) {
        console.warn(`[worker] Job ${message.jobId} not found in database, skipping.`);
        continue;
      }

      if (job.status !== "queued") {
        console.warn(`[worker] Job ${message.jobId} has status "${job.status}", expected "queued". Skipping.`);
        continue;
      }

      if (!job.sourceId || !job.fileId) {
        console.error(`[worker] Job ${message.jobId} missing sourceId or fileId. Marking as failed.`);
        await markJobFailed(job.id, "Job missing sourceId or fileId");
        continue;
      }

      // Load the file's storage path from DB
      const fileResult = await query<{ storage_path: string }>(
        "SELECT storage_path FROM files WHERE id = $1",
        [job.fileId],
      );

      if (fileResult.rows.length === 0) {
        await markJobFailed(job.id, `File record ${job.fileId} not found in database`);
        continue;
      }

      const originalPdfPath = fileResult.rows[0].storage_path;

      console.log(`[worker] Running pipeline for job ${job.id}...`);
      const result = await runPipeline({
        jobId: job.id,
        sourceId: job.sourceId,
        fileId: job.fileId,
        originalPdfPath,
      });

      console.log(
        `[worker] Job ${job.id} completed. ` +
        `Chunks: ${result.chunksPersisted}, Pages: ${result.pagesPersisted}, ` +
        `Quality: ${result.qualityReport.overall.status} (${result.qualityReport.overall.score}/100)`,
      );

      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[worker] Error processing job (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, message);
    }
  }

  console.error(`[worker] Exceeded ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Shutting down.`);

  const client = getRedisClient();
  if (client.isOpen) {
    await client.disconnect();
  }

  process.exit(1);
}

runWorker().catch((error) => {
  console.error("[worker] Fatal error:", error);
  process.exit(1);
});
