import type { PoolClient } from "pg";

import { withTransaction } from "../db/client.ts";

export const SOURCE_ARCHIVE_ERROR_CODES = {
  titleRequired: "SOURCE_ARCHIVE_TITLE_REQUIRED",
  notFound: "SOURCE_NOT_FOUND",
  alreadyArchived: "SOURCE_ALREADY_ARCHIVED",
  titleMismatch: "SOURCE_ARCHIVE_TITLE_MISMATCH",
  activeJobs: "SOURCE_HAS_ACTIVE_JOBS",
  nfsManaged: "SOURCE_MANAGED_BY_NFS",
} as const;

export type SourceArchiveErrorCode = typeof SOURCE_ARCHIVE_ERROR_CODES[keyof typeof SOURCE_ARCHIVE_ERROR_CODES];

export class SourceArchiveError extends Error {
  readonly status: 400 | 404 | 409;
  readonly code: SourceArchiveErrorCode;

  constructor(
    message: string,
    status: 400 | 404 | 409,
    code: SourceArchiveErrorCode,
  ) {
    super(message);
    this.name = "SourceArchiveError";
    this.status = status;
    this.code = code;
  }
}

export type ArchivedSource = Readonly<{
  id: string;
  title: string;
  deletedAt: string;
}>;

export async function archiveSource(sourceId: string, expectedTitle: string): Promise<ArchivedSource> {
  return withTransaction((client) => archiveSourceWithClient(client, sourceId, expectedTitle));
}

/** The source row is the lifecycle lock shared by archive and job creation. */
export async function archiveSourceWithClient(
  client: Pick<PoolClient, "query">,
  sourceId: string,
  expectedTitle: string,
): Promise<ArchivedSource> {
  if (typeof expectedTitle !== "string") {
    throw new SourceArchiveError(
      "confirmationTitle is required.",
      400,
      SOURCE_ARCHIVE_ERROR_CODES.titleRequired,
    );
  }

  const source = await client.query<{ id: string; title: string; deleted_at: Date | string | null }>(
    "SELECT id, title, deleted_at FROM sources WHERE id = $1 FOR UPDATE",
    [sourceId],
  );
  const row = source.rows[0];
  if (!row) {
    throw new SourceArchiveError("Source was not found.", 404, SOURCE_ARCHIVE_ERROR_CODES.notFound);
  }
  if (row.deleted_at !== null) {
    throw new SourceArchiveError("Source is already archived.", 409, SOURCE_ARCHIVE_ERROR_CODES.alreadyArchived);
  }
  if (expectedTitle !== row.title) {
    throw new SourceArchiveError(
      "Enter the current source title exactly to confirm archival.",
      409,
      SOURCE_ARCHIVE_ERROR_CODES.titleMismatch,
    );
  }

  const activeJob = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM ingestion_jobs
     WHERE source_id = $1 AND status IN ('queued', 'processing')
     ORDER BY queued_at ASC LIMIT 1`,
    [sourceId],
  );
  if (activeJob.rows[0]) {
    throw new SourceArchiveError(
      `Source cannot be archived while ingestion job ${activeJob.rows[0].id} is ${activeJob.rows[0].status}.`,
      409,
      SOURCE_ARCHIVE_ERROR_CODES.activeJobs,
    );
  }

  const nfsMapping = await client.query<{ repository_id: string }>(
    "SELECT repository_id FROM nfs_index_managed_sources WHERE source_id = $1 LIMIT 1",
    [sourceId],
  );
  if (nfsMapping.rows[0]) {
    throw new SourceArchiveError(
      `Source is managed by NFS repository ${nfsMapping.rows[0].repository_id} and cannot be archived here.`,
      409,
      SOURCE_ARCHIVE_ERROR_CODES.nfsManaged,
    );
  }

  const archived = await client.query<{ id: string; title: string; deleted_at: Date | string }>(
    `UPDATE sources SET deleted_at = now(), updated_at = now()
     WHERE id = $1 RETURNING id, title, deleted_at`,
    [sourceId],
  );
  const archivedRow = archived.rows[0];
  return {
    id: archivedRow.id,
    title: archivedRow.title,
    deletedAt: archivedRow.deleted_at instanceof Date
      ? archivedRow.deleted_at.toISOString()
      : archivedRow.deleted_at,
  };
}

export function mapSourceArchiveError(error: unknown): Readonly<{
  status: 400 | 404 | 409;
  body: Readonly<{ error: string; code: SourceArchiveErrorCode }>;
}> | null {
  if (!(error instanceof SourceArchiveError)) return null;
  return { status: error.status, body: { error: error.message, code: error.code } };
}
