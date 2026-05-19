/**
 * High-level ingestion lifecycle: create source → store PDF → create job → enqueue.
 */

import { storeOriginalPdf, createSourceRecord, createIngestionJob, getIngestionJob } from "./storage";
import { enqueueJob } from "./queue";
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
 * 1. Create source record
 * 2. Store original PDF
 * 3. Create ingestion job
 * 4. Enqueue for worker processing
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

  const queueId = await enqueueJob(job.id);

  // Store the queue_id reference
  const { query } = await import("../db/client");
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
