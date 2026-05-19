/**
 * Admin actions for ingestion job management: retry, reprocess, delete.
 *
 * All actions require admin authorization (enforced at the API route layer).
 * Status guards prevent invalid state transitions.
 * Delete uses soft-delete (deleted_at) on sources, with CASCADE removing
 * related files, documents, pages, chunks. Artifacts on disk are also removed.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

import { query, withTransaction } from "../db/client";
import {
  getIngestionJob,
  createIngestionJob,
  type IngestionJobRecord,
} from "./storage";
import { enqueueJob } from "./queue";
import { getStorageRoot } from "./paths";

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

  if (originalJob.status !== "failed" && originalJob.status !== "cancelled") {
    throw new Error(
      `Cannot retry job ${jobId}: current status is "${originalJob.status}". Only "failed" or "cancelled" jobs can be retried.`,
    );
  }

  if (!originalJob.sourceId || !originalJob.fileId) {
    throw new Error(
      `Cannot retry job ${jobId}: missing source or file reference.`,
    );
  }

  // Verify source still exists and is not soft-deleted
  const sourceCheck = await query<{ deleted_at: string | null }>(
    "SELECT deleted_at FROM sources WHERE id = $1",
    [originalJob.sourceId],
  );
  if (sourceCheck.rows.length === 0) {
    throw new Error(
      `Cannot retry job ${jobId}: source ${originalJob.sourceId} no longer exists.`,
    );
  }
  if (sourceCheck.rows[0].deleted_at !== null) {
    throw new Error(
      `Cannot retry job ${jobId}: source ${originalJob.sourceId} has been deleted.`,
    );
  }

  // Verify file still exists
  const fileCheck = await query<{ id: string }>(
    "SELECT id FROM files WHERE id = $1 AND deleted_at IS NULL",
    [originalJob.fileId],
  );
  if (fileCheck.rows.length === 0) {
    throw new Error(
      `Cannot retry job ${jobId}: file ${originalJob.fileId} no longer exists.`,
    );
  }

  const job = await createIngestionJob({
    kind: "retry",
    sourceId: originalJob.sourceId,
    fileId: originalJob.fileId,
    requestedByUserId,
    metadata: {
      retryOf: jobId,
      originalKind: originalJob.kind,
    },
  });

  const queueId = await enqueueJob(job.id);

  return { job, queueId };
}

// ---------------------------------------------------------------------------
// Reprocess
// ---------------------------------------------------------------------------

/**
 * Reprocesses a source by creating a new "reprocess" job. The original PDF is
 * preserved. Any existing chunks, pages, and documents from previous jobs are
 * removed before the new job runs, ensuring a clean re-ingestion.
 *
 * @returns The new reprocess job record.
 */
export async function reprocessSource(
  sourceId: string,
  requestedByUserId: string,
): Promise<{ job: IngestionJobRecord; queueId: string }> {
  // Verify source exists and is not deleted
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
    throw new Error(`Source ${sourceId} has been deleted and cannot be reprocessed.`);
  }

  // Check no job is currently active (queued/processing) for this source
  const activeJobs = await query<{ id: string; status: string }>(
    `SELECT id, status FROM ingestion_jobs
     WHERE source_id = $1 AND status IN ('queued', 'processing')`,
    [sourceId],
  );
  if (activeJobs.rows.length > 0) {
    const active = activeJobs.rows[0];
    throw new Error(
      `Cannot reprocess source ${sourceId}: job ${active.id} is currently "${active.status}". Wait for it to finish or cancel it first.`,
    );
  }

  // Find the latest file for this source
  const fileResult = await query<{
    id: string;
    storage_path: string;
    artifacts_root: string | null;
  }>(
    `SELECT id, storage_path, processed_artifacts_root AS artifacts_root
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

  // Within a transaction: remove old artifacts from previous successful jobs
  // (chunks, pages, documents from prior jobs), then create new reprocess job
  const { job, oldArtifactsRoot } = await withTransaction(async (client) => {
    // Delete chunks from previous jobs for this source
    await client.query(
      `DELETE FROM chunks WHERE source_id = $1`,
      [sourceId],
    );

    // Delete pages from previous jobs for this source
    await client.query(
      `DELETE FROM pages WHERE source_id = $1`,
      [sourceId],
    );

    // Delete documents from previous jobs for this source
    await client.query(
      `DELETE FROM documents WHERE source_id = $1`,
      [sourceId],
    );

    const job = await createIngestionJob({
      kind: "reprocess",
      sourceId,
      fileId: file.id,
      requestedByUserId,
      metadata: { reprocessOfSource: sourceId },
    });

    return { job, oldArtifactsRoot: file.artifacts_root };
  });

  // Remove old processed artifacts from disk (outside transaction)
  if (oldArtifactsRoot) {
    try {
      await rm(oldArtifactsRoot, { recursive: true, force: true });
    } catch (err) {
      // Non-fatal: artifact cleanup failure should not block reprocessing
      console.error(
        `[reprocess] Failed to remove old artifacts at ${oldArtifactsRoot}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const queueId = await enqueueJob(job.id);

  return { job, queueId };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Soft-deletes a source by setting `deleted_at`. CASCADE on FK relationships
 * will handle files, documents, pages, chunks cleanup in the DB. Also removes
 * processed artifacts and original files from disk.
 *
 * Any active (queued/processing) jobs for this source are cancelled first.
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

  // Cancel any active jobs
  const activeJobs = await query<{ id: string }>(
    `UPDATE ingestion_jobs
     SET status = 'cancelled', finished_at = now()
     WHERE source_id = $1 AND status IN ('queued', 'processing')
     RETURNING id`,
    [sourceId],
  );
  const cancelledJobs = activeJobs.rows.map((r) => r.id);

  // Collect file paths for disk cleanup
  const files = await query<{ id: string; storage_path: string; processed_artifacts_root: string | null }>(
    "SELECT id, storage_path, processed_artifacts_root FROM files WHERE source_id = $1",
    [sourceId],
  );

  // Soft-delete the source (CASCADE handles files, docs, pages, chunks)
  await query(
    "UPDATE sources SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
    [sourceId],
  );

  // Remove files from disk (outside DB transaction)
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
