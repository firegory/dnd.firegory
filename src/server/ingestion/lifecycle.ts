/**
 * High-level ingestion lifecycle: create source → store PDF → create job → enqueue.
 *
 * NOTE: The DB operations (createSourceRecord, storeOriginalPdf, createIngestionJob)
 * each use the shared query pool, not a single transaction client. This means a crash
 * between operations could leave orphaned records. For MVP this is acceptable since:
 * - The worker can handle re-processing of partially-created records
 * - Issue #15 will add admin retry/reprocess/delete actions
 * - A future iteration should add transaction-aware overloads that accept a PoolClient
 */

import { storeOriginalPdf, createSourceRecord, createIngestionJob, getIngestionJob } from "./storage";
import { enqueueJob } from "./queue";
import { query } from "../db/client";
import type { AccessTier, SourceCategory, SourceEdition, SourceLanguage } from "../access/retrieval-filter";

export type StartIngestionInput = Readonly<{
  title: string;
  category: SourceCategory;
  edition: SourceEdition;
  language: SourceLanguage;
  accessTier: AccessTier;
  ownerUserId?: string | null;
  requestedByUserId?: string | null;
  originalFilename: string;
  pdfData: Buffer;
  kind?: "upload" | "cli";
  metadata?: Record<string, unknown>;
}>;

export type IngestionResult = Readonly<{
  sourceId: string;
  fileId: string;
  jobId: string;
  queueId: string;
}>;

/**
 * Full ingestion lifecycle:
 * 1. Store original PDF to disk (before any DB records)
 * 2. Create source record
 * 3. Create file record (with correct path, single INSERT)
 * 4. Create ingestion job
 * 5. Enqueue for worker processing
 *
 * Operations are ordered so that:
 * - File is written before DB records (no dangling DB references to missing files)
 * - Queue enqueue is last (if it fails, job stays in "queued" and can be re-enqueued)
 */
export async function startIngestion(input: StartIngestionInput): Promise<IngestionResult> {
  const sourceId = await createSourceRecord({
    title: input.title,
    category: input.category,
    edition: input.edition,
    language: input.language,
    accessTier: input.accessTier,
    ownerUserId: input.ownerUserId,
    createdByUserId: input.requestedByUserId,
    metadata: input.metadata,
  });

  const { fileId } = await storeOriginalPdf({
    sourceId,
    originalFilename: input.originalFilename,
    data: input.pdfData,
    requestedByUserId: input.requestedByUserId,
  });

  const job = await createIngestionJob({
    kind: input.kind ?? "upload",
    sourceId,
    fileId,
    requestedByUserId: input.requestedByUserId,
    metadata: input.metadata,
  });

  // Queue operations are outside DB — Redis is external
  const queueId = await enqueueJob(job.id);
  await query("UPDATE ingestion_jobs SET queue_id = $1 WHERE id = $2", [queueId, job.id]);

  return {
    sourceId,
    fileId,
    jobId: job.id,
    queueId,
  };
}

/**
 * Retrieves a job and its current status.
 */
export async function getIngestionStatus(jobId: string) {
  return getIngestionJob(jobId);
}
