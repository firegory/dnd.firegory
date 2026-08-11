/**
 * Admin actions for ingestion job management: retry and reprocess.
 *
 * All actions require admin authorization (enforced at the API route layer).
 * Status guards prevent invalid state transitions.
 */

import { withTransaction } from "../db/client.ts";
import {
  getIngestionJob,
  createIngestionJob,
  type IngestionJobRecord,
} from "./storage.ts";
import { enqueueJob } from "./queue.ts";

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Retries a failed (or cancelled) ingestion job by creating a new "retry" job
 * that references the same source and file. The original job record is left
 * untouched for audit purposes.
 *
 * @returns The new retry job record.
 * @throws If the original job is not in a retryable state.
 */
export async function retryFailedJob(
  jobId: string,
  requestedByUserId: string,
): Promise<{ job: IngestionJobRecord; queueId: string }> {
  const originalJob = await getIngestionJob(jobId);
  if (!originalJob) {
    throw new Error(`Ingestion job not found: ${jobId}`);
  }

  if (!originalJob.sourceId || !originalJob.fileId) {
    throw new Error(
      `Cannot retry job ${jobId}: missing source or file reference.`,
    );
  }
  const sourceId = originalJob.sourceId;
  const fileId = originalJob.fileId;

  let job: IngestionJobRecord;
  try {
    job = await withTransaction(async (client) => {
      const source = await client.query<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM sources WHERE id = $1 FOR UPDATE",
        [sourceId],
      );
      if (!source.rows[0] || source.rows[0].deleted_at !== null) {
        throw new Error(`Cannot retry job ${jobId}: source ${sourceId} is archived or unavailable.`);
      }

      const file = await client.query<{ source_id: string; deleted_at: string | null }>(
        "SELECT source_id, deleted_at FROM files WHERE id = $1 FOR UPDATE",
        [fileId],
      );
      if (!file.rows[0] || file.rows[0].deleted_at !== null) {
        throw new Error(`Cannot retry job ${jobId}: file ${fileId} no longer exists.`);
      }
      if (file.rows[0].source_id !== sourceId) {
        throw new Error(`Cannot retry job ${jobId}: file ownership does not match the original job.`);
      }

      const current = await client.query<{ status: string; source_id: string | null; file_id: string | null }>(
        "SELECT status, source_id, file_id FROM ingestion_jobs WHERE id = $1",
        [jobId],
      );
      if (!current.rows[0]
        || !["failed", "cancelled"].includes(current.rows[0].status)
        || current.rows[0].source_id !== sourceId
        || current.rows[0].file_id !== fileId) {
        throw new Error(`Cannot retry job ${jobId}: it is no longer a matching failed or cancelled job.`);
      }

      const active = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM ingestion_jobs
         WHERE file_id = $1 AND status IN ('queued', 'processing')`,
        [fileId],
      );
      if (active.rows[0]) throw replacementConflict(fileId, active.rows[0]);

      return createIngestionJob({
        kind: "retry",
        sourceId,
        fileId,
        requestedByUserId,
        metadata: { retryOf: jobId, originalKind: originalJob.kind },
        client,
      });
    });
  } catch (error) {
    if (isActiveJobUniqueViolation(error)) throw replacementConflict(fileId);
    throw error;
  }

  const queueId = await enqueueJob(job.id);

  return { job, queueId };
}

// ---------------------------------------------------------------------------
// Reprocess
// ---------------------------------------------------------------------------

/**
 * Reprocesses a source by creating a new "reprocess" job. The original PDF and
 * active generation remain available until the replacement is validated and
 * atomically activated by the worker.
 *
 * The active-jobs check and job creation run inside a single transaction with
 * row-level locks to prevent concurrent reprocess requests.
 *
 * @returns The new reprocess job record.
 */
export async function reprocessSource(
  sourceId: string,
  requestedByUserId: string,
): Promise<{ job: IngestionJobRecord; queueId: string }> {
  // Lock active jobs and create the replacement job atomically. Content and
  // artifacts are immutable generation data and are not removed here.
  let job: IngestionJobRecord;
  try {
    job = await withTransaction(async (client) => {
      const source = await client.query<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM sources WHERE id = $1 FOR UPDATE",
        [sourceId],
      );
      if (!source.rows[0]) throw new Error(`Source not found: ${sourceId}`);
      if (source.rows[0].deleted_at !== null) {
        throw new Error(`Source ${sourceId} is archived and cannot be reprocessed.`);
      }

      const fileResult = await client.query<{ id: string }>(
        `SELECT id FROM files
         WHERE source_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [sourceId],
      );
      const file = fileResult.rows[0];
      if (!file) {
        throw new Error(`Cannot reprocess source ${sourceId}: no active file found.`);
      }

      const lockedFile = await client.query<{ source_id: string; deleted_at: string | null }>(
        "SELECT source_id, deleted_at FROM files WHERE id = $1 FOR UPDATE",
        [file.id],
      );
      if (!lockedFile.rows[0]
        || lockedFile.rows[0].source_id !== sourceId
        || lockedFile.rows[0].deleted_at !== null) {
        throw new Error(`Cannot reprocess source ${sourceId}: selected file is unavailable.`);
      }

      const activeJobs = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM ingestion_jobs
         WHERE file_id = $1 AND status IN ('queued', 'processing')`,
        [file.id],
      );
      if (activeJobs.rows[0]) throw replacementConflict(file.id, activeJobs.rows[0]);

      return createIngestionJob({
        kind: "reprocess",
        sourceId,
        fileId: file.id,
        requestedByUserId,
        metadata: { reprocessOfSource: sourceId },
        client,
      });
    });
  } catch (error) {
    if (isActiveJobUniqueViolation(error)) throw replacementConflict("the selected source file");
    throw error;
  }

  const queueId = await enqueueJob(job.id);

  return { job, queueId };
}

function replacementConflict(fileId: string, active?: { id: string; status: string }): Error {
  const detail = active ? `: job ${active.id} is ${active.status}` : "";
  return new Error(`Cannot create replacement for file ${fileId}; another job is active${detail}.`);
}

function isActiveJobUniqueViolation(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "23505"
    && "constraint" in error
    && error.constraint === "ingestion_jobs_one_active_file_idx";
}
