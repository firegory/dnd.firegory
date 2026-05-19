/**
 * Worker entrypoint for processing ingestion jobs from the Redis queue.
 *
 * This is a minimal worker that dequeues jobs and updates their status.
 * Actual PDF processing (extraction, OCR, chunking, embeddings) will be
 * added in issue #8.
 */

import { ensureRedisConnection, dequeueJob, getRedisClient } from "../server/ingestion/queue";
import {
  getIngestionJob,
  markJobProcessing,
  markJobSucceeded,
} from "../server/ingestion/storage";

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

      await markJobProcessing(job.id);
      console.log(`[worker] Processing job ${job.id}...`);

      // Actual processing will be implemented in issue #8
      // For now, mark as succeeded with a placeholder
      await markJobSucceeded(job.id);
      console.log(`[worker] Job ${job.id} completed (placeholder — no processing yet).`);

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
