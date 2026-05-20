/**
 * High-level ingestion lifecycle: create source → store PDF → create job → enqueue.
 *
 * DB mutations (source, file, job) run inside a single transaction so a crash
 * between operations cannot leave partially-created records. File I/O (writing
 * the PDF to disk) is performed before the DB INSERT within each storage
 * function, keeping the invariant that DB records reference an existing file.
 * Redis enqueue is outside the transaction since it's an external system;
 * if it fails the job remains in "queued" and can be re-enqueued.
 */

import { storeOriginalPdf, createSourceRecord, createIngestionJob, getIngestionJob } from "./storage.ts";
import { enqueueJob } from "./queue.ts";
import { withTransaction } from "../db/client.ts";
import type { AccessTier, SourceCategory, SourceEdition, SourceLanguage } from "../access/retrieval-filter.ts";

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
 * 1. [Transaction] Create source record
 * 2. [Transaction] Store original PDF to disk + create file record
 *    (file is written before INSERT; if disk write fails, transaction rolls back)
 * 3. [Transaction] Create ingestion job
 * 4. Enqueue for worker processing (outside transaction — Redis is external)
 *
 * Operations are ordered so that:
 * - Files are written before DB records reference them
 * - DB mutations are atomic — either all three records are created or none
 * - Queue enqueue is last (if it fails, job stays in "queued" and can be re-enqueued)
 */
export async function startIngestion(input: StartIngestionInput): Promise<IngestionResult> {
  const { sourceId, fileId, job } = await withTransaction(async (client) => {
    const sourceId = await createSourceRecord({
      title: input.title,
      category: input.category,
      edition: input.edition,
      language: input.language,
      accessTier: input.accessTier,
      ownerUserId: input.ownerUserId,
      createdByUserId: input.requestedByUserId,
      metadata: input.metadata,
      client,
    });

    const { fileId } = await storeOriginalPdf({
      sourceId,
      originalFilename: input.originalFilename,
      data: input.pdfData,
      requestedByUserId: input.requestedByUserId,
      client,
    });

    const job = await createIngestionJob({
      kind: input.kind ?? "upload",
      sourceId,
      fileId,
      requestedByUserId: input.requestedByUserId,
      metadata: input.metadata,
      client,
    });

    return { sourceId, fileId, job };
  });

  // Queue operations are outside DB transaction — Redis is external.
  // If enqueue fails, the job remains in "queued" and can be re-enqueued.
  const queueId = await enqueueJob(job.id);

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
