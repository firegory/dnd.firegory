import type { QueryResultRow } from "pg";

import { assertAdminContext, type AdminContext } from "../admin/admin-context.ts";
import {
  readOutboxState,
  submitPublicationCommand,
  submitUnpublicationCommand,
} from "../content-storage/publication-command.ts";
import {
  createCanonicalRevision,
  type CanonicalRevision,
  type CanonicalRevisionInput,
  type ContentSource,
  type JsonValue,
} from "../content-storage/repository.ts";
import { assertCanonicalRevision } from "../content-storage/validation.ts";
import { withTransaction } from "../db/client.ts";

type DbClient = Readonly<{
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}>;
type TransactionRunner = <T>(callback: (client: DbClient) => Promise<T>) => Promise<T>;

export type ReviewDecision = "pending" | "approved" | "rejected" | "merged" | "unpublish";
export type ReviewPublicationStatus = "idle" | "pending" | "queued" | "completed" | "failed";
export type ReviewAction = "approve" | "reject" | "merge" | "unpublish" | "retry";

export type ImportRunSummary = Readonly<{
  id: string;
  sourceId: string;
  sourceTitle: string;
  fileId: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  counts: Readonly<Record<string, number>>;
}>;

export type ImportCandidateReview = Readonly<{
  id: string;
  candidateKey: string;
  entryType: string | null;
  diffStatus: string;
  content: Record<string, unknown>;
  previousContent: Record<string, unknown> | null;
  invalidReason: string | null;
  locator: string | null;
  chunkId: string | null;
  page: number | null;
  decision: ReviewDecision;
  resolvedContent: Record<string, unknown> | null;
  publicationStatus: ReviewPublicationStatus;
  lastError: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}>;

export class ImportReviewError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ImportReviewError";
    this.status = status;
  }
}

type CandidateRow = QueryResultRow & Readonly<{
  id: string;
  import_run_id: string;
  candidate_key: string;
  entry_type: string | null;
  diff_status: string;
  content: Record<string, unknown>;
  previous_content: Record<string, unknown> | null;
  invalid_reason: string | null;
  locator: string | null;
  chunk_id: string | null;
  page_number: number | null;
  created_at: Date | string;
  run_status: string;
  decision: ReviewDecision | null;
  resolved_content: Record<string, unknown> | null;
  publication_status: ReviewPublicationStatus | null;
  publication_attempt: number | null;
  idempotency_key: string | null;
  last_error: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
}>;

type Submitters = Readonly<{
  publish: typeof submitPublicationCommand;
  unpublish: typeof submitUnpublicationCommand;
  readState: typeof readOutboxState;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILTERS = new Set(["new", "unchanged", "changed", "missing", "duplicate", "invalid"]);

export class CompendiumImportReviewService {
  private readonly transaction: TransactionRunner;
  private readonly submitters: Submitters;

  constructor(
    transaction: TransactionRunner = withTransaction as TransactionRunner,
    submitters: Submitters = {
      publish: submitPublicationCommand,
      unpublish: submitUnpublicationCommand,
      readState: readOutboxState,
    },
  ) {
    this.transaction = transaction;
    this.submitters = submitters;
  }

  async listRuns(admin: AdminContext, options: Readonly<{ status?: string; limit?: number; offset?: number }> = {}): Promise<readonly ImportRunSummary[]> {
    assertAdminContext(admin);
    const limit = boundedInteger(options.limit, 50, 1, 200);
    const offset = boundedInteger(options.offset, 0, 0, 1_000_000);
    if (options.status && !["pending", "running", "succeeded", "failed", "cancelled"].includes(options.status)) {
      throw new ImportReviewError("Invalid import run status filter.");
    }
    return this.transaction(async (client) => {
      const values: unknown[] = [];
      const where = options.status ? `WHERE run.status = $${values.push(options.status)}` : "";
      const result = await client.query<QueryResultRow & Record<string, unknown>>(
        `SELECT run.id, run.source_id, source.title AS source_title, run.file_id, run.status,
                run.created_at, run.finished_at, run.candidate_count, run.new_count,
                run.unchanged_count, run.changed_count, run.missing_count,
                run.duplicate_count, run.invalid_count, run.diagnostic_count,
                (run.candidate_count - count(*) FILTER (WHERE review.decision <> 'pending'))::integer AS pending_review_count,
                count(*) FILTER (WHERE review.publication_status = 'failed')::integer AS failed_publication_count
         FROM compendium_import_runs run
         JOIN sources source ON source.id = run.source_id
         LEFT JOIN compendium_import_candidate_reviews review ON review.import_run_id = run.id
         ${where}
         GROUP BY run.id, source.title
         ORDER BY run.created_at DESC, run.id DESC
         LIMIT $${values.push(limit)} OFFSET $${values.push(offset)}`,
        values,
      );
      return result.rows.map((row) => ({
        id: String(row.id), sourceId: String(row.source_id), sourceTitle: String(row.source_title),
        fileId: String(row.file_id), status: String(row.status), createdAt: iso(row.created_at),
        finishedAt: row.finished_at == null ? null : iso(row.finished_at),
        counts: {
          candidates: number(row.candidate_count), new: number(row.new_count), unchanged: number(row.unchanged_count),
          changed: number(row.changed_count), missing: number(row.missing_count), duplicate: number(row.duplicate_count),
          invalid: number(row.invalid_count), diagnostics: number(row.diagnostic_count),
          pending: number(row.pending_review_count), publicationFailed: number(row.failed_publication_count),
        },
      }));
    });
  }

  async getRun(admin: AdminContext, runId: string, diffStatus?: string): Promise<Readonly<{
    run: ImportRunSummary;
    candidates: readonly ImportCandidateReview[];
    diagnostics: readonly Record<string, unknown>[];
    audit: readonly Record<string, unknown>[];
  }>> {
    assertAdminContext(admin); requireUuid(runId, "runId");
    if (diffStatus && !FILTERS.has(diffStatus)) throw new ImportReviewError("Invalid candidate status filter.");
    await this.reconcilePublicationStates(admin, runId);
    return this.transaction(async (client) => {
      const runs = await this.listRunsWithClient(client, runId);
      const run = runs[0];
      if (!run) throw new ImportReviewError("Import run was not found.", 404);
      const values: unknown[] = [runId];
      const filter = diffStatus ? `AND candidate.diff_status = $${values.push(diffStatus)}` : "";
      const candidates = await client.query<CandidateRow>(candidateSelect(`${filter} ORDER BY candidate.candidate_order, candidate.id`), values);
      const diagnostics = await client.query<QueryResultRow & Record<string, unknown>>(
        `SELECT diagnostic_key AS "diagnosticKey", level, code, message, details, created_at AS "createdAt"
         FROM compendium_import_diagnostics WHERE import_run_id = $1 ORDER BY created_at, id`, [runId],
      );
      const audit = await client.query<QueryResultRow & Record<string, unknown>>(
        `SELECT event_type AS "eventType", candidate_id AS "candidateId", actor, details, created_at AS "createdAt"
         FROM compendium_import_review_audit WHERE import_run_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, [runId],
      );
      return { run, candidates: candidates.rows.map(mapCandidate), diagnostics: diagnostics.rows, audit: audit.rows };
    });
  }

  async act(admin: AdminContext, runId: string, input: Readonly<{
    candidateIds: readonly string[];
    action: ReviewAction;
    resolvedContent?: Record<string, unknown>;
    resolvedContents?: Readonly<Record<string, Record<string, unknown>>>;
  }>): Promise<readonly Readonly<{ candidateId: string; publicationStatus: ReviewPublicationStatus; error?: string }>[]> {
    assertAdminContext(admin); requireUuid(runId, "runId");
    if (!Array.isArray(input.candidateIds) || input.candidateIds.length < 1 || input.candidateIds.length > 200) {
      throw new ImportReviewError("candidateIds must contain between 1 and 200 candidates.");
    }
    const ids = [...new Set(input.candidateIds)];
    ids.forEach((id) => requireUuid(id, "candidateId"));
    if (!["approve", "reject", "merge", "unpublish", "retry"].includes(input.action)) throw new ImportReviewError("Invalid review action.");
    if (input.action === "merge" && ids.length > 1 && !input.resolvedContents) {
      throw new ImportReviewError("Bulk merge requires resolvedContents keyed by candidate ID.");
    }

    const prepared = await this.transaction(async (client) => {
      const rows = await client.query<CandidateRow>(candidateSelect("AND candidate.id = ANY($2::uuid[]) ORDER BY candidate.id FOR UPDATE OF candidate"), [runId, ids]);
      if (rows.rows.length !== ids.length) throw new ImportReviewError("One or more candidates were not found in this run.", 404);
      const actions: Array<{ row: CandidateRow; key: string | null; revision: CanonicalRevision | null }> = [];
      for (const row of rows.rows) {
        const currentStatus = row.publication_status ?? "idle";
        const currentDecision = row.decision ?? "pending";
        if (row.run_status !== "succeeded") throw new ImportReviewError("Only successful import runs can be reviewed.", 409);
        if (input.action === "retry") {
          if (!["failed", "pending"].includes(currentStatus) || !["approved", "merged", "unpublish"].includes(currentDecision)) {
            throw new ImportReviewError(`Candidate ${row.candidate_key} has no recoverable publication to retry.`, 409);
          }
        } else if (currentStatus !== "idle") {
          throw new ImportReviewError(`Candidate ${row.candidate_key} already has publication activity.`, 409);
        }
        const decision = decisionFor(input.action, currentDecision);
        assertDecisionAllowed(row.diff_status, decision);
        const resolved = input.action === "merge" ? input.resolvedContents?.[row.id] ?? input.resolvedContent : row.resolved_content;
        if (decision === "merged" && !isRecord(resolved)) throw new ImportReviewError("Merge requires a resolved content object.");
        const shouldPublish = ["approved", "merged", "unpublish"].includes(decision);
        const reusePending = input.action === "retry" && currentStatus === "pending";
        const attempt = shouldPublish ? (reusePending ? row.publication_attempt ?? 1 : (row.publication_attempt ?? 0) + 1) : 0;
        const key = shouldPublish ? (reusePending ? row.idempotency_key ?? reviewIdempotencyKey(runId, row.id, attempt) : reviewIdempotencyKey(runId, row.id, attempt)) : null;
        const revision = decision === "approved" || decision === "merged"
          ? await buildRevision(client, row, decision === "merged" ? resolved! : row.content)
          : null;
        await client.query(
          `INSERT INTO compendium_import_candidate_reviews
             (candidate_id, import_run_id, decision, resolved_content, publication_status,
              publication_attempt, idempotency_key, last_error, reviewed_by, reviewed_at, updated_at)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,NULL,$8,now(),now())
           ON CONFLICT (candidate_id) DO UPDATE SET
             decision = EXCLUDED.decision, resolved_content = EXCLUDED.resolved_content,
             publication_status = EXCLUDED.publication_status,
             publication_attempt = EXCLUDED.publication_attempt, idempotency_key = EXCLUDED.idempotency_key,
             last_error = NULL, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at, updated_at = now()`,
          [row.id, runId, decision, resolved ? JSON.stringify(resolved) : null, shouldPublish ? "pending" : "idle", attempt, key, admin.userId],
        );
        await audit(client, runId, row.id, input.action, admin.userId, { decision, publicationAttempt: attempt || undefined });
        actions.push({ row, key, revision });
      }
      return actions;
    });

    const results = [];
    for (const item of prepared) {
      if (!item.key) {
        results.push({ candidateId: item.row.id, publicationStatus: "idle" as const });
        continue;
      }
      try {
        if (item.revision) await this.submitters.publish({ idempotencyKey: item.key, revision: item.revision });
        else await this.submitters.unpublish({ idempotencyKey: item.key, entryId: item.row.candidate_key });
        await this.setPublicationResult(runId, item.row.id, item.key, "queued", null, admin.userId);
        results.push({ candidateId: item.row.id, publicationStatus: "queued" as const });
      } catch (error) {
        const message = errorMessage(error);
        await this.setPublicationResult(runId, item.row.id, item.key, "failed", message, admin.userId);
        results.push({ candidateId: item.row.id, publicationStatus: "failed" as const, error: message });
      }
    }
    return results;
  }

  private async reconcilePublicationStates(admin: AdminContext, runId: string): Promise<void> {
    const active = await this.transaction((client) => client.query<QueryResultRow & { candidate_id: string; idempotency_key: string; publication_status: ReviewPublicationStatus }>(
      `SELECT candidate_id, idempotency_key, publication_status FROM compendium_import_candidate_reviews
       WHERE import_run_id = $1 AND publication_status IN ('pending','queued','failed')`, [runId],
    ));
    for (const row of active.rows) {
      let state;
      try { state = await this.submitters.readState(process.env.PUBLICATION_SPOOL_ROOT ?? `${process.env.STORAGE_ROOT ?? "./storage"}/publication-spool`, row.idempotency_key); }
      catch { continue; }
      if (!state || state.status === row.publication_status) continue;
      await this.setPublicationResult(runId, row.candidate_id, row.idempotency_key, state.status, state.lastError ?? null, admin.userId);
    }
  }

  private async setPublicationResult(runId: string, candidateId: string, key: string, status: ReviewPublicationStatus, error: string | null, actor: string): Promise<void> {
    await this.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE compendium_import_candidate_reviews SET publication_status = $4, last_error = $5, updated_at = now()
         WHERE import_run_id = $1 AND candidate_id = $2 AND idempotency_key = $3 AND publication_status <> 'completed'`,
        [runId, candidateId, key, status, error],
      );
      if (updated.rowCount) await audit(client, runId, candidateId, `publication_${status}`, actor, error ? { error } : {});
    });
  }

  private async listRunsWithClient(client: DbClient, runId: string): Promise<readonly ImportRunSummary[]> {
    const result = await client.query<QueryResultRow & Record<string, unknown>>(
      `SELECT run.id, run.source_id, source.title AS source_title, run.file_id, run.status,
              run.created_at, run.finished_at, run.candidate_count, run.new_count, run.unchanged_count,
              run.changed_count, run.missing_count, run.duplicate_count, run.invalid_count, run.diagnostic_count,
              (run.candidate_count - count(*) FILTER (WHERE review.decision <> 'pending'))::integer AS pending_review_count,
              count(*) FILTER (WHERE review.publication_status = 'failed')::integer AS failed_publication_count
       FROM compendium_import_runs run JOIN sources source ON source.id = run.source_id
       LEFT JOIN compendium_import_candidate_reviews review ON review.import_run_id = run.id
       WHERE run.id = $1 GROUP BY run.id, source.title`, [runId],
    );
    return result.rows.map((row) => ({ id: String(row.id), sourceId: String(row.source_id), sourceTitle: String(row.source_title), fileId: String(row.file_id), status: String(row.status), createdAt: iso(row.created_at), finishedAt: row.finished_at == null ? null : iso(row.finished_at), counts: { candidates: number(row.candidate_count), new: number(row.new_count), unchanged: number(row.unchanged_count), changed: number(row.changed_count), missing: number(row.missing_count), duplicate: number(row.duplicate_count), invalid: number(row.invalid_count), diagnostics: number(row.diagnostic_count), pending: number(row.pending_review_count), publicationFailed: number(row.failed_publication_count) } }));
  }
}

function candidateSelect(suffix: string): string {
  return `SELECT candidate.id, candidate.import_run_id, candidate.candidate_key, candidate.entry_type,
                 candidate.diff_status, candidate.content, previous.content AS previous_content,
                 candidate.invalid_reason, candidate.created_at, run.status AS run_status,
                 occurrence.locator, occurrence.chunk_id, chunk.page_number,
                 review.decision, review.resolved_content, review.publication_status,
                 review.publication_attempt, review.idempotency_key, review.last_error,
                 review.reviewed_by, review.reviewed_at
          FROM compendium_import_candidates candidate
          JOIN compendium_import_runs run ON run.id = candidate.import_run_id
          LEFT JOIN compendium_import_candidates previous ON previous.id = candidate.previous_candidate_id
          LEFT JOIN compendium_import_occurrences occurrence ON occurrence.id = candidate.occurrence_id
          LEFT JOIN chunks chunk ON chunk.id = occurrence.chunk_id
          LEFT JOIN compendium_import_candidate_reviews review ON review.candidate_id = candidate.id
          WHERE candidate.import_run_id = $1 ${suffix}`;
}

async function buildRevision(client: DbClient, candidate: CandidateRow, content: Record<string, unknown>): Promise<CanonicalRevision> {
  if (!isRecord(content.entry) || !isRecord(content.text) || !Array.isArray(content.citations)) {
    throw new ImportReviewError("Publishable candidate content requires entry, text, and citations.");
  }
  const sourceResult = await client.query<QueryResultRow & Record<string, unknown>>(
    `SELECT source.*, coalesce(jsonb_agg(jsonb_build_object(
              'fileId', file.id::text, 'path', 'sources/' || source.canonical_source_id || '/files/' || file.id || '.pdf',
              'mediaType', file.mime_type, 'contentHash', 'sha256:' || file.checksum_sha256
            ) ORDER BY file.id) FILTER (WHERE file.id IS NOT NULL), '[]'::jsonb) AS canonical_files
     FROM sources source LEFT JOIN files file ON file.source_id = source.id AND file.deleted_at IS NULL
     WHERE source.id = (SELECT source_id FROM compendium_import_runs WHERE id = $1) AND source.deleted_at IS NULL
     GROUP BY source.id`, [candidate.import_run_id],
  );
  const row = sourceResult.rows[0];
  if (!row || !row.canonical_source_id || !row.publication_code || !row.publisher || !row.release_year || !row.canonical_book_id) {
    throw new ImportReviewError("Complete canonical source publication metadata is required before publishing.", 409);
  }
  const source: ContentSource = {
    schemaVersion: 1, kind: "source", sourceId: String(row.canonical_source_id), title: String(row.title),
    category: row.category as ContentSource["category"], edition: row.edition as ContentSource["edition"],
    language: row.language as ContentSource["language"], accessTier: row.access_tier as ContentSource["accessTier"],
    shared: Boolean(row.shared), ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id),
    publication: {
      code: String(row.publication_code), title: String(row.publication_title), publisher: String(row.publisher),
      releaseYear: Number(row.release_year), ...(row.publication_revision ? { revision: String(row.publication_revision) } : {}),
      ...(row.external_origin_url && row.external_origin_id ? { origin: { url: String(row.external_origin_url), id: String(row.external_origin_id) } } : {}),
      ...(row.attribution ? { attribution: String(row.attribution) } : {}), sourcePriority: Number(row.source_priority),
      canonicalBookId: String(row.canonical_book_id),
    },
    ...(row.license ? { license: String(row.license) } : {}), files: row.canonical_files as ContentSource["files"],
  };
  const input: CanonicalRevisionInput = {
    schemaVersion: 1, kind: "canonicalRevision", entryId: candidate.candidate_key,
    createdAt: iso(candidate.created_at), source,
    entry: content.entry as Record<string, JsonValue>, text: content.text as Record<string, JsonValue>,
    citations: content.citations as readonly Record<string, JsonValue>[],
  };
  const revision = createCanonicalRevision(input);
  assertCanonicalRevision(revision);
  return revision;
}

function mapCandidate(row: CandidateRow): ImportCandidateReview {
  return { id: row.id, candidateKey: row.candidate_key, entryType: row.entry_type, diffStatus: row.diff_status,
    content: row.content, previousContent: row.previous_content, invalidReason: row.invalid_reason, locator: row.locator,
    chunkId: row.chunk_id, page: row.page_number, decision: row.decision ?? "pending", resolvedContent: row.resolved_content,
    publicationStatus: row.publication_status ?? "idle", lastError: row.last_error, reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at == null ? null : iso(row.reviewed_at) };
}

function decisionFor(action: ReviewAction, current: ReviewDecision): ReviewDecision {
  if (action === "approve") return "approved";
  if (action === "reject") return "rejected";
  if (action === "merge") return "merged";
  if (action === "unpublish") return "unpublish";
  return current;
}

function assertDecisionAllowed(diffStatus: string, decision: ReviewDecision): void {
  if (decision === "approved" && !["new", "changed", "unchanged"].includes(diffStatus)) throw new ImportReviewError(`${diffStatus} candidates cannot be approved without a merge.`);
  if (decision === "unpublish" && diffStatus !== "missing") throw new ImportReviewError("Only missing candidates can be unpublished.");
}

function reviewIdempotencyKey(runId: string, candidateId: string, attempt: number): string {
  return `review-${runId.replaceAll("-", "")}-${candidateId.replaceAll("-", "")}-${attempt}`;
}

async function audit(client: DbClient, runId: string, candidateId: string, event: string, actor: string, details: Record<string, unknown>): Promise<void> {
  await client.query(`INSERT INTO compendium_import_review_audit (import_run_id, candidate_id, event_type, actor, details) VALUES ($1,$2,$3,$4,$5::jsonb)`, [runId, candidateId, event, actor, JSON.stringify(details)]);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value!)) : fallback;
}
function requireUuid(value: string, name: string): void { if (!UUID.test(value)) throw new ImportReviewError(`${name} must be a UUID.`); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function number(value: unknown): number { return Number(value ?? 0); }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 4000) : "Publication failed."; }
