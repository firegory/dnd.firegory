import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { query } from "../db/client.ts";
import type {
  AccessTier,
  SourceCategory,
  SourceEdition,
  SourceLanguage,
} from "../access/retrieval-filter.ts";
import { normalizeSourceInput, type PublicationMetadataInput } from "../content/metadata.ts";
import { computeChecksum, originalFilePath, getStorageRoot } from "./paths.ts";

export type IngestionJobRecord = Readonly<{
  id: string;
  kind: "upload" | "cli" | "retry" | "reprocess";
  status: "queued" | "processing" | "succeeded" | "failed" | "cancelled";
  queueId: string | null;
  sourceId: string | null;
  fileId: string | null;
  requestedByUserId: string | null;
  metadata: Record<string, unknown>;
  progress: number;
  errorSummary: string | null;
  logPath: string | null;
  artifactsRoot: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}>;

type IngestionJobRow = Readonly<{
  id: string;
  kind: string;
  status: string;
  queue_id: string | null;
  source_id: string | null;
  file_id: string | null;
  requested_by_user_id: string | null;
  metadata: Record<string, unknown>;
  progress: number;
  error_summary: string | null;
  log_path: string | null;
  artifacts_root: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}>;

function rowToRecord(row: IngestionJobRow): IngestionJobRecord {
  return {
    id: row.id,
    kind: row.kind as IngestionJobRecord["kind"],
    status: row.status as IngestionJobRecord["status"],
    queueId: row.queue_id,
    sourceId: row.source_id,
    fileId: row.file_id,
    requestedByUserId: row.requested_by_user_id,
    metadata: row.metadata,
    progress: row.progress,
    errorSummary: row.error_summary,
    logPath: row.log_path,
    artifactsRoot: row.artifacts_root,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Stores the original PDF to disk and creates the corresponding file record in the DB.
 *
 * Writes the file to disk first, then inserts the DB record with the correct
 * storage path in a single query. This avoids the invariant break where the
 * DB could point at a "pending" path that doesn't exist on disk.
 *
 * @param client Optional PoolClient for running within a transaction.
 */
export async function storeOriginalPdf(input: {
  sourceId: string;
  originalFilename: string;
  data: Buffer;
  requestedByUserId?: string | null;
  client?: PoolClient;
}): Promise<{ fileId: string; checksumSha256: string }> {
  const checksum = computeChecksum(input.data);
  const byteSize = input.data.byteLength;

  // Generate file ID before writing so the path is deterministic
  const fileId = randomUUID();
  const storagePath = originalFilePath(input.sourceId, fileId);

  // Write file to disk first — if this fails, no DB record is created
  await mkdir(join(getStorageRoot(), "originals", input.sourceId), { recursive: true });
  await writeFile(storagePath, input.data);

  const sql = `INSERT INTO files (id, source_id, original_filename, mime_type, checksum_sha256, byte_size, storage_path, uploaded_by_user_id)
     VALUES ($1, $2, $3, 'application/pdf', $4, $5, $6, $7)`;
  const params = [
    fileId,
    input.sourceId,
    input.originalFilename,
    checksum,
    byteSize,
    storagePath,
    input.requestedByUserId ?? null,
  ];

  // Single INSERT with the correct storage path
  if (input.client) {
    await input.client.query(sql, params);
  } else {
    await query(sql, params);
  }

  return { fileId, checksumSha256: checksum };
}

/**
 * Creates a source record and returns its ID.
 *
 * @param client Optional PoolClient for running within a transaction.
 */
export async function createSourceRecord(input: {
  title: string;
  category: SourceCategory;
  edition: SourceEdition;
  language: SourceLanguage;
  accessTier: AccessTier;
  ownerUserId?: string | null;
  canonicalSourceId?: string | null;
  publication?: PublicationMetadataInput;
  license?: string | null;
  createdByUserId?: string | null;
  metadata?: Record<string, unknown>;
  client?: PoolClient;
}): Promise<string> {
  const normalized = normalizeSourceInput({
    title: input.title,
    category: input.category,
    edition: input.edition,
    language: input.language,
    accessTier: input.accessTier,
    ownerUserId: input.ownerUserId,
    canonicalSourceId: input.canonicalSourceId,
    publication: input.publication,
    license: input.license,
    metadata: input.metadata,
  });

  const sql = `INSERT INTO sources (
       canonical_source_id, title, category, edition, language, access_tier, shared,
       owner_user_id, publication_code, publication_title, publisher, release_year,
       publication_revision, external_origin_url, external_origin_id, attribution,
       source_priority, canonical_book_id, license, created_by_user_id, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19, $20, $21)
     RETURNING id`;
  const params = [
    normalized.canonicalSourceId,
    normalized.title,
    normalized.category,
    normalized.edition,
    normalized.language,
    normalized.accessTier,
    normalized.shared,
    normalized.ownerUserId,
    normalized.publication.code,
    normalized.publication.title,
    normalized.publication.publisher,
    normalized.publication.releaseYear,
    normalized.publication.revision,
    normalized.publication.origin?.url ?? null,
    normalized.publication.origin?.id ?? null,
    normalized.publication.attribution,
    normalized.publication.sourcePriority,
    normalized.publication.canonicalBookId,
    normalized.license,
    input.createdByUserId ?? null,
    JSON.stringify(normalized.metadata ?? {}),
  ];

  const result = input.client
    ? await input.client.query<{ id: string }>(sql, params)
    : await query<{ id: string }>(sql, params);
  return result.rows[0].id;
}

/**
 * Creates an ingestion job in queued state.
 *
 * @param client Optional PoolClient for running within a transaction.
 */
export async function createIngestionJob(input: {
  kind: "upload" | "cli" | "retry" | "reprocess";
  sourceId?: string | null;
  fileId?: string | null;
  requestedByUserId?: string | null;
  metadata?: Record<string, unknown>;
  queueId?: string | null;
  client?: PoolClient;
}): Promise<IngestionJobRecord> {
  const sql = `INSERT INTO ingestion_jobs (kind, source_id, file_id, requested_by_user_id, metadata, queue_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`;
  const params = [
    input.kind,
    input.sourceId ?? null,
    input.fileId ?? null,
    input.requestedByUserId ?? null,
    JSON.stringify(input.metadata ?? {}),
    input.queueId ?? null,
  ];

  const result = input.client
    ? await input.client.query<IngestionJobRow>(sql, params)
    : await query<IngestionJobRow>(sql, params);
  return rowToRecord(result.rows[0]);
}

/**
 * Transitions an ingestion job to processing state.
 */
export async function markJobProcessing(
  jobId: string,
  execute: typeof query = query,
): Promise<boolean> {
  const result = await execute<{ id: string }>(
    `UPDATE ingestion_jobs
     SET status = 'processing', started_at = now()
     WHERE id = $1 AND status = 'queued'
     RETURNING id`,
    [jobId],
  );
  return result.rows.length === 1;
}

/**
 * Marks an ingestion job as succeeded.
 */
export async function markJobSucceeded(
  jobId: string,
  artifactsRoot?: string,
): Promise<void> {
  await query(
    `UPDATE ingestion_jobs
     SET status = 'succeeded', finished_at = now(), progress = 100, artifacts_root = COALESCE($2, artifacts_root)
     WHERE id = $1`,
    [jobId, artifactsRoot ?? null],
  );
}

/**
 * Marks an ingestion job as failed with an error summary.
 */
export async function markJobFailed(
  jobId: string,
  errorSummary: string,
): Promise<void> {
  await query(
    `UPDATE ingestion_jobs
     SET status = 'failed', finished_at = now(), error_summary = $2
     WHERE id = $1 AND status IN ('queued', 'processing')`,
    [jobId, errorSummary],
  );
}

/**
 * Updates job progress (0–100).
 */
export async function updateJobProgress(
  jobId: string,
  progress: number,
): Promise<void> {
  await query("UPDATE ingestion_jobs SET progress = $2 WHERE id = $1", [
    jobId,
    Math.max(0, Math.min(100, progress)),
  ]);
}

/**
 * Retrieves a single ingestion job by ID.
 */
export async function getIngestionJob(jobId: string): Promise<IngestionJobRecord | null> {
  const result = await query<IngestionJobRow>(
    "SELECT * FROM ingestion_jobs WHERE id = $1",
    [jobId],
  );
  const row = result.rows[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Lists ingestion jobs, optionally filtered by status.
 */
export async function listIngestionJobs(options?: {
  status?: IngestionJobRecord["status"];
  limit?: number;
  offset?: number;
}): Promise<IngestionJobRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (options?.status) {
    conditions.push(`status = $${paramIdx++}`);
    values.push(options.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  values.push(limit, offset);

  const result = await query<IngestionJobRow>(
    `SELECT * FROM ingestion_jobs ${where} ORDER BY queued_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    values,
  );
  return result.rows.map(rowToRecord);
}
