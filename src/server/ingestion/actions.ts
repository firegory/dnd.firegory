/**
 * Admin actions for ingestion job management: retry, reprocess, delete.
 *
 * All actions require admin authorization (enforced at the API route layer).
 * Status guards prevent invalid state transitions.
 * Delete soft-deletes the source for audit, then hard-deletes files (which
 * cascades to documents, pages, chunks). Artifacts on disk are also removed.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

import { query, withTransaction } from "../db/client.ts";
import {
  getIngestionJob,
  createIngestionJob,
  type IngestionJobRecord,
} from "./storage.ts";
import { enqueueJob } from "./queue.ts";
import { getStorageRoot } from "./paths.ts";

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

      const source = await client.query<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM sources WHERE id = $1",
        [sourceId],
      );
      if (!source.rows[0] || source.rows[0].deleted_at !== null) {
        throw new Error(`Cannot retry job ${jobId}: source ${sourceId} is unavailable.`);
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
  // Find the latest file for this source
  const fileResult = await query<{
    id: string;
  }>(
    `SELECT id
     FROM files
     WHERE source_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [sourceId],
  );
  if (fileResult.rows.length === 0) {
    throw new Error(
      `Cannot reprocess source ${sourceId}: no active file found.`,
    );
  }

  const file = fileResult.rows[0];

  // Lock active jobs and create the replacement job atomically. Content and
  // artifacts are immutable generation data and are not removed here.
  let job: IngestionJobRecord;
  try {
    job = await withTransaction(async (client) => {
      const lockedFile = await client.query<{ source_id: string; deleted_at: string | null }>(
        "SELECT source_id, deleted_at FROM files WHERE id = $1 FOR UPDATE",
        [file.id],
      );
      if (!lockedFile.rows[0]
        || lockedFile.rows[0].source_id !== sourceId
        || lockedFile.rows[0].deleted_at !== null) {
        throw new Error(`Cannot reprocess source ${sourceId}: selected file is unavailable.`);
      }

      const source = await client.query<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM sources WHERE id = $1",
        [sourceId],
      );
      if (!source.rows[0]) throw new Error(`Source not found: ${sourceId}`);
      if (source.rows[0].deleted_at !== null) {
        throw new Error(`Source ${sourceId} has been deleted and cannot be reprocessed.`);
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
    if (isActiveJobUniqueViolation(error)) throw replacementConflict(file.id);
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

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Soft-deletes a source by setting `deleted_at`, preserving the source record
 * for audit. Then hard-deletes files which cascades to documents, pages, and
 * chunks via ON DELETE CASCADE FK constraints. Also removes processed
 * artifacts and original files from disk.
 *
 * Any active (queued/processing) jobs for this source are cancelled first.
 * All DB mutations run inside a single transaction for atomicity.
 *
 * @throws If the source doesn't exist or is already deleted.
 */
export async function deleteSource(
  sourceId: string,
  _requestedByUserId: string,
): Promise<{
  cancelledJobs: string[];
  removedFiles: string[];
}> {
  // Verify source exists
  const sourceCheck = await query<{
    id: string;
    deleted_at: string | null;
  }>(
    "SELECT id, deleted_at FROM sources WHERE id = $1",
    [sourceId],
  );
  if (sourceCheck.rows.length === 0) {
    throw new Error(`Source not found: ${sourceId}`);
  }
  if (sourceCheck.rows[0].deleted_at !== null) {
    throw new Error(`Source ${sourceId} is already deleted.`);
  }

  // Collect file paths for disk cleanup (before DB changes)
  const files = await query<{ id: string; storage_path: string; processed_artifacts_root: string | null }>(
    "SELECT id, storage_path, processed_artifacts_root FROM files WHERE source_id = $1",
    [sourceId],
  );

  // All DB mutations inside a transaction for atomicity
  const cancelledJobs = await withTransaction<string[]>(async (client) => {
    // Cancel any active jobs
    const activeJobs = await client.query<{ id: string }>(
      `UPDATE ingestion_jobs
       SET status = 'cancelled', finished_at = now()
       WHERE source_id = $1 AND status IN ('queued', 'processing')
       RETURNING id`,
      [sourceId],
    );
    const cancelled = activeJobs.rows.map((r) => r.id);

    // Soft-delete the source for audit trail
    await client.query(
      "UPDATE sources SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
      [sourceId],
    );

    // Hard-delete files — ON DELETE CASCADE removes documents, pages, chunks
    await client.query(
      "DELETE FROM files WHERE source_id = $1",
      [sourceId],
    );

    return cancelled;
  });

  // Remove files from disk (outside DB transaction — non-fatal)
  const removedFiles: string[] = [];
  for (const file of files.rows) {
    // Remove original file
    try {
      await rm(file.storage_path, { force: true });
      removedFiles.push(file.storage_path);
    } catch (err) {
      console.error(
        `[delete] Failed to remove original file ${file.storage_path}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Remove processed artifacts
    if (file.processed_artifacts_root) {
      try {
        await rm(file.processed_artifacts_root, { recursive: true, force: true });
        removedFiles.push(file.processed_artifacts_root);
      } catch (err) {
        console.error(
          `[delete] Failed to remove artifacts ${file.processed_artifacts_root}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // Also attempt to remove the source directory from storage
  try {
    const storageRoot = getStorageRoot();
    const sourceOriginalsDir = join(storageRoot, "originals", sourceId);
    await rm(sourceOriginalsDir, { recursive: true, force: true });
    const sourceProcessedDir = join(storageRoot, "processed", sourceId);
    await rm(sourceProcessedDir, { recursive: true, force: true });
  } catch (err) {
    // Non-fatal
    console.error(
      `[delete] Failed to clean source directory for ${sourceId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return { cancelledJobs, removedFiles };
}
