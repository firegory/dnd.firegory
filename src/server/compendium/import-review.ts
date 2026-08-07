import type { QueryResultRow } from "pg";

import { assertAdminContext, type AdminContext } from "../admin/admin-context.ts";
import {
  submitPublicationCommand,
  submitUnpublicationCommand,
} from "../content-storage/publication-command.ts";
import {
  getDataRoot,
  type CanonicalRevision,
  type ContentSource,
} from "../content-storage/repository.ts";
import { loadResolvedRepositoryManifest } from "../content-storage/validation.ts";
import { withTransaction } from "../db/client.ts";
import {
  canonicalCandidateEntryId,
  CandidateProjectionError,
  classifyCandidatePublication,
  projectExtractedCandidate,
  projectSnapshotSpellCandidate,
  type SnapshotSpellEvidence,
  type CandidatePublicationCapability,
} from "./candidate-publication.ts";
import type { CompendiumEntryType } from "./service.ts";

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
  entryId: string | null;
  entryType: string | null;
  diffStatus: string;
  content: Record<string, unknown>;
  previousContent: Record<string, unknown> | null;
  invalidReason: string | null;
  locator: string | null;
  chunkId: string | null;
  page: number | null;
  evidenceSourceId: string | null;
  evidenceFileId: string | null;
  evidenceGenerationId: string | null;
  activeRevisionToken: string | null;
  payloadOrigin: CandidatePublicationCapability["payloadOrigin"];
  publicationCapability: CandidatePublicationCapability["publicationCapability"];
  publicationBlockReason: string | null;
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
  occurrence_id: string | null;
  previous_candidate_id: string | null;
  source_id: string;
  file_id: string;
  generation_id: string | null;
  edition: unknown;
  language: unknown;
  access_tier: unknown;
  shared: unknown;
  owner_user_id: unknown;
  candidate_key: string;
  entry_type: string | null;
  diff_status: string;
  content: Record<string, unknown>;
  content_sha256: string;
  previous_content: Record<string, unknown> | null;
  previous_content_sha256: string | null;
  previous_source_id: string | null;
  previous_file_id: string | null;
  previous_generation_id: string | null;
  previous_candidate_key: string | null;
  previous_entry_type: string | null;
  previous_created_at: Date | string | null;
  previous_occurrence_id: string | null;
  previous_locator: string | null;
  previous_fingerprint_sha256: string | null;
  previous_raw_blob_path: string | null;
  previous_source_fetched_at: Date | string | null;
  previous_chunk_id: string | null;
  previous_page_number: number | null;
  previous_chunk_index: number | null;
  previous_section_heading: string | null;
  previous_quote_text: string | null;
  previous_decision: ReviewDecision | null;
  previous_resolved_content: Record<string, unknown> | null;
  previous_publication_status: ReviewPublicationStatus | null;
  invalid_reason: string | null;
  locator: string | null;
  occurrence_fingerprint_sha256: string | null;
  occurrence_raw_blob_path: string | null;
  occurrence_source_fetched_at: Date | string | null;
  file_checksum_sha256: string;
  chunk_id: string | null;
  page_number: number | null;
  chunk_index: number | null;
  section_heading: string | null;
  quote_text: string | null;
  created_at: Date | string;
  run_status: string;
  decision: ReviewDecision | null;
  resolved_content: Record<string, unknown> | null;
  publication_status: ReviewPublicationStatus | null;
  publication_attempt: number | null;
  idempotency_key: string | null;
  expected_active_revision_id: string | null;
  expected_active_revision_captured: boolean | null;
  last_error: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
}>;

type Submitters = Readonly<{
  publish: typeof submitPublicationCommand;
  unpublish: typeof submitUnpublicationCommand;
}>;
type ActiveRevisionReader = (entryIds: readonly string[]) => Promise<ReadonlyMap<string, string | null>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILTERS = new Set(["new", "unchanged", "changed", "missing", "duplicate", "invalid"]);

export class CompendiumImportReviewService {
  private readonly transaction: TransactionRunner;
  private readonly submitters: Submitters;
  private readonly readActiveRevision: ActiveRevisionReader;

  constructor(
    transaction: TransactionRunner = withTransaction as TransactionRunner,
    submitters: Submitters = {
      publish: submitPublicationCommand,
      unpublish: submitUnpublicationCommand,
    },
    readActiveRevision: ActiveRevisionReader = defaultActiveRevisionReader,
  ) {
    this.transaction = transaction;
    this.submitters = submitters;
    this.readActiveRevision = readActiveRevision;
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
    return this.transaction(async (client) => {
      const runs = await this.listRunsWithClient(client, runId);
      const run = runs[0];
      if (!run) throw new ImportReviewError("Import run was not found.", 404);
      const values: unknown[] = [runId];
      const filter = diffStatus ? `AND candidate.diff_status = $${values.push(diffStatus)}` : "";
      const candidates = await client.query<CandidateRow>(candidateSelect(`${filter} ORDER BY candidate.candidate_order, candidate.id`), values);
      const capabilities = new Map(candidates.rows.map((candidate) => [candidate.id, candidateCapability(candidate)]));
      const previousRevisionIds = new Map<string, string>();
      for (const candidate of candidates.rows) {
        if (capabilities.get(candidate.id)?.publicationCapability !== "can_unpublish") continue;
        try {
          previousRevisionIds.set(candidate.id, (await buildPreviousRevision(client, candidate)).revisionId);
        } catch (error) {
          capabilities.set(candidate.id, blockedCapability(capabilities.get(candidate.id)!, `Previous publication cannot be reconstructed: ${errorMessage(error)}`));
        }
      }
      const entryIds = new Map(candidates.rows.map((candidate) => [
        candidate.id,
        ["publishable", "can_unpublish"].includes(capabilities.get(candidate.id)?.publicationCapability ?? "") ? candidateEntryId(candidate) : null,
      ]));
      const activeRevisionTokens = await this.readActiveRevision([...new Set([...entryIds.values()].filter((entryId): entryId is string => entryId !== null))]);
      const diagnostics = await client.query<QueryResultRow & Record<string, unknown>>(
        `SELECT diagnostic_key AS "diagnosticKey", level, code, message, details, created_at AS "createdAt"
         FROM compendium_import_diagnostics WHERE import_run_id = $1 ORDER BY created_at, id`, [runId],
      );
      const audit = await client.query<QueryResultRow & Record<string, unknown>>(
        `SELECT event_type AS "eventType", candidate_id AS "candidateId", actor,
                initiating_actor AS "initiatingActor", details, created_at AS "createdAt"
         FROM compendium_import_review_audit WHERE import_run_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, [runId],
      );
      return {
        run,
        candidates: candidates.rows.map((candidate) => {
          const entryId = entryIds.get(candidate.id) ?? null;
          const activeRevisionToken = entryId ? activeRevisionTokens.get(entryId) ?? null : null;
          const expectedPreviousRevision = previousRevisionIds.get(candidate.id);
          if (expectedPreviousRevision && activeRevisionToken !== expectedPreviousRevision) {
            capabilities.set(candidate.id, blockedCapability(capabilities.get(candidate.id)!, "The previous published revision is not the active canonical CAS target."));
          }
          return {
            ...mapCandidate(candidate), ...capabilities.get(candidate.id)!, entryId,
            activeRevisionToken,
          };
        }),
        diagnostics: diagnostics.rows,
        audit: audit.rows,
      };
    });
  }

  async act(admin: AdminContext, runId: string, input: Readonly<{
    candidateIds: readonly string[];
    action: ReviewAction;
    activeRevisionTokens?: Readonly<Record<string, string | null>>;
    resolvedContent?: Record<string, unknown>;
    resolvedContents?: Readonly<Record<string, Record<string, unknown>>>;
  }>): Promise<readonly Readonly<{ candidateId: string; publicationStatus: ReviewPublicationStatus; error?: string }>[]> {
    assertAdminContext(admin); requireUuid(runId, "runId");
    if (!Array.isArray(input.candidateIds) || input.candidateIds.length < 1 || input.candidateIds.length > 200) {
      throw new ImportReviewError("candidateIds must contain between 1 and 200 candidates.");
    }
    const ids = [...new Set(input.candidateIds)];
    if (ids.length !== input.candidateIds.length) throw new ImportReviewError("candidateIds must not contain duplicates.");
    ids.forEach((id) => requireUuid(id, "candidateId"));
    if (!["approve", "reject", "merge", "unpublish", "retry"].includes(input.action)) throw new ImportReviewError("Invalid review action.");
    if (input.action !== "merge" && (input.resolvedContent !== undefined || input.resolvedContents !== undefined)) {
      throw new ImportReviewError("Resolved content is only accepted for merge actions.");
    }
    if (input.action === "merge" && (input.resolvedContent === undefined) === (input.resolvedContents === undefined)) {
      throw new ImportReviewError("Merge requires exactly one resolved content payload.");
    }
    if (input.resolvedContent !== undefined && ids.length !== 1) {
      throw new ImportReviewError("resolvedContent is only valid for a single candidate merge.");
    }
    if (input.resolvedContents) {
      const keys = Object.keys(input.resolvedContents).sort();
      const expected = [...ids].sort();
      if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw new ImportReviewError("resolvedContents must contain exactly every selected candidate ID.");
      }
    }
    const publishes = input.action !== "reject";
    if (publishes) validateActiveRevisionTokens(input.activeRevisionTokens, ids);
    else if (input.activeRevisionTokens !== undefined) throw new ImportReviewError("Active revision tokens are not accepted for reject actions.");

    const prepared = await this.transaction(async (client) => {
      const rows = await client.query<CandidateRow>(candidateSelect("AND candidate.id = ANY($2::uuid[]) ORDER BY candidate.id FOR UPDATE OF candidate"), [runId, ids]);
      if (rows.rows.length !== ids.length) throw new ImportReviewError("One or more candidates were not found in this run.", 404);
      const publicationContents = new Map(rows.rows.map((row) => {
        const resolved = input.action === "merge" ? input.resolvedContents?.[row.id] ?? input.resolvedContent : null;
        return [row.id, input.action === "merge" && isRecord(resolved) ? lockCollectorSpellMerge(row, resolved) : row.content] as const;
      }));
      const capabilities = new Map(rows.rows.map((row) => [row.id, input.action === "merge" && isSnapshotSpellContent(row.content)
        ? classifyCandidatePublication(publicationContents.get(row.id), capabilityContext(row, currentEvidence(row)))
        : candidateCapability(row)]));
      if (input.action !== "reject") {
        for (const row of rows.rows) {
          const capability = capabilities.get(row.id)!;
          if (capability.publicationCapability === "requires_extraction") {
            throw new ImportReviewError(`Candidate ${row.candidate_key} is not publishable: ${capability.publicationBlockReason}`, 409);
          }
          if (input.action === "retry" && (!["failed", "pending"].includes(row.publication_status ?? "idle")
              || !["approved", "merged", "unpublish"].includes(row.decision ?? "pending"))) {
            throw new ImportReviewError(`Candidate ${row.candidate_key} has no recoverable publication to retry.`, 409);
          }
          assertDecisionAllowed(row.diff_status, decisionFor(input.action, row.decision ?? "pending"));
          const requiredCapability = input.action === "unpublish" || (input.action === "retry" && row.decision === "unpublish")
            ? "can_unpublish" : "publishable";
          if (capability.publicationCapability !== requiredCapability) {
            const reason = capability.publicationBlockReason ?? `Candidate only supports ${capability.publicationCapability === "can_unpublish" ? "unpublication" : "canonical publication"}.`;
            throw new ImportReviewError(`Candidate ${row.candidate_key} cannot ${input.action}: ${reason}`, 409);
          }
          if (requiredCapability === "can_unpublish") {
            const expectedRevisionId = (await buildPreviousRevision(client, row)).revisionId;
            if (input.activeRevisionTokens![row.id] !== expectedRevisionId) {
              throw new ImportReviewError(`Candidate ${row.candidate_key} cannot be unpublished because its previous published revision is not the displayed canonical CAS target.`, 409);
            }
          }
        }
      }
      const actions: Array<{ row: CandidateRow; entryId: string | null; key: string | null; revision: CanonicalRevision | null; expectedActiveRevisionId: string | null }> = [];
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
        const resolved = input.action === "merge" ? publicationContents.get(row.id) : row.resolved_content;
        if (decision === "merged" && !isRecord(resolved)) throw new ImportReviewError("Merge requires a resolved content object.");
        const shouldPublish = ["approved", "merged", "unpublish"].includes(decision);
        const entryId = shouldPublish ? requiredCandidateEntryId(row) : null;
        const reusePending = input.action === "retry" && currentStatus === "pending";
        const attempt = shouldPublish ? (reusePending ? row.publication_attempt ?? 1 : (row.publication_attempt ?? 0) + 1) : 0;
        const key = shouldPublish ? (reusePending ? row.idempotency_key ?? reviewIdempotencyKey(runId, row.id, attempt) : reviewIdempotencyKey(runId, row.id, attempt)) : null;
        const revision = decision === "approved" || decision === "merged"
          ? await buildRevision(client, row, decision === "merged" ? resolved! : row.content)
          : null;
        const displayedToken = shouldPublish ? input.activeRevisionTokens![row.id] : null;
        const expectedActiveRevisionId = reusePending
          ? requireMatchingCapturedExpectation(row, displayedToken)
          : displayedToken;
        await client.query(
          `INSERT INTO compendium_import_candidate_reviews
             (candidate_id, import_run_id, decision, resolved_content, publication_status,
              publication_attempt, idempotency_key, expected_active_revision_id,
              expected_active_revision_captured, last_error, reviewed_by, reviewed_at, updated_at)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,NULL,$10,now(),now())
           ON CONFLICT (candidate_id) DO UPDATE SET
             decision = EXCLUDED.decision, resolved_content = EXCLUDED.resolved_content,
             publication_status = EXCLUDED.publication_status,
             publication_attempt = EXCLUDED.publication_attempt, idempotency_key = EXCLUDED.idempotency_key,
             expected_active_revision_id = EXCLUDED.expected_active_revision_id,
             expected_active_revision_captured = EXCLUDED.expected_active_revision_captured,
             last_error = NULL, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at, updated_at = now()`,
          [row.id, runId, decision, resolved ? JSON.stringify(resolved) : null, shouldPublish ? "pending" : "idle", attempt, key,
            expectedActiveRevisionId, shouldPublish, admin.userId],
        );
        await audit(client, runId, row.id, input.action, admin.userId, admin.userId, { decision, publicationAttempt: attempt || undefined, expectedActiveRevisionId });
        actions.push({ row, entryId, key, revision, expectedActiveRevisionId });
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
        if (item.revision) await this.submitters.publish({ idempotencyKey: item.key, expectedActiveRevisionId: item.expectedActiveRevisionId, revision: item.revision });
        else await this.submitters.unpublish({ idempotencyKey: item.key, expectedActiveRevisionId: item.expectedActiveRevisionId, entryId: item.entryId! });
        await this.markPublicationQueued(runId, item.row.id, item.key, admin.userId);
        results.push({ candidateId: item.row.id, publicationStatus: "queued" as const });
      } catch (error) {
        const message = errorMessage(error);
        results.push({ candidateId: item.row.id, publicationStatus: "pending" as const, error: message });
      }
    }
    return results;
  }

  private async markPublicationQueued(runId: string, candidateId: string, key: string, initiatingActor: string): Promise<void> {
    await this.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE compendium_import_candidate_reviews SET publication_status = 'queued', last_error = NULL, updated_at = now()
         WHERE import_run_id = $1 AND candidate_id = $2 AND idempotency_key = $3 AND publication_status = 'pending'`,
        [runId, candidateId, key],
      );
      if (updated.rowCount) await audit(client, runId, candidateId, "publication_queued", "publication-system", initiatingActor, {});
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
  return `SELECT candidate.id, candidate.import_run_id, candidate.occurrence_id, candidate.previous_candidate_id,
                 candidate.source_id, candidate.file_id, candidate.generation_id,
                 candidate.candidate_key, candidate.entry_type,
                 source.edition, source.language, source.access_tier, source.shared, source.owner_user_id,
                 candidate.diff_status, candidate.content, candidate.content_sha256,
                 previous.content AS previous_content, previous.content_sha256 AS previous_content_sha256,
                 previous.source_id AS previous_source_id, previous.file_id AS previous_file_id,
                 previous.generation_id AS previous_generation_id, previous.candidate_key AS previous_candidate_key,
                 previous.entry_type AS previous_entry_type, previous.created_at AS previous_created_at,
                 candidate.invalid_reason, candidate.created_at, run.status AS run_status,
                  occurrence.locator, occurrence.fingerprint_sha256 AS occurrence_fingerprint_sha256,
                  occurrence.raw_blob_path AS occurrence_raw_blob_path,
                  occurrence.source_fetched_at AS occurrence_source_fetched_at,
                  source_file.checksum_sha256 AS file_checksum_sha256,
                  occurrence.chunk_id, chunk.page_number, chunk.chunk_index,
                 chunk.section_heading, chunk.quote_text,
                  previous.occurrence_id AS previous_occurrence_id, previous_occurrence.locator AS previous_locator,
                  previous_occurrence.fingerprint_sha256 AS previous_fingerprint_sha256,
                  previous_occurrence.raw_blob_path AS previous_raw_blob_path,
                  previous_occurrence.source_fetched_at AS previous_source_fetched_at,
                  previous_occurrence.chunk_id AS previous_chunk_id,
                 previous_chunk.page_number AS previous_page_number, previous_chunk.chunk_index AS previous_chunk_index,
                 previous_chunk.section_heading AS previous_section_heading, previous_chunk.quote_text AS previous_quote_text,
                 previous_review.decision AS previous_decision,
                 previous_review.resolved_content AS previous_resolved_content,
                 previous_review.publication_status AS previous_publication_status,
                 review.decision, review.resolved_content, review.publication_status,
                 review.publication_attempt, review.idempotency_key, review.last_error,
                 review.expected_active_revision_id, review.expected_active_revision_captured,
                  review.reviewed_by, review.reviewed_at
          FROM compendium_import_candidates candidate
          JOIN compendium_import_runs run ON run.id = candidate.import_run_id
          JOIN sources source ON source.id = candidate.source_id
          JOIN files source_file ON source_file.id = candidate.file_id AND source_file.source_id = candidate.source_id
          LEFT JOIN compendium_import_candidates previous ON previous.id = candidate.previous_candidate_id
          LEFT JOIN compendium_import_occurrences occurrence ON occurrence.id = candidate.occurrence_id
          LEFT JOIN chunks chunk ON chunk.id = occurrence.chunk_id
          LEFT JOIN compendium_import_occurrences previous_occurrence ON previous_occurrence.id = previous.occurrence_id
          LEFT JOIN chunks previous_chunk ON previous_chunk.id = previous_occurrence.chunk_id
          LEFT JOIN compendium_import_candidate_reviews previous_review ON previous_review.candidate_id = previous.id
          LEFT JOIN compendium_import_candidate_reviews review ON review.candidate_id = candidate.id
          WHERE candidate.import_run_id = $1 ${suffix}`;
}

async function buildRevision(client: DbClient, candidate: CandidateRow, content: Record<string, unknown>): Promise<CanonicalRevision> {
  const sourceResult = await client.query<QueryResultRow & Record<string, unknown>>(
    `SELECT source.*, coalesce(jsonb_agg(jsonb_build_object(
               'fileId', file.id::text, 'path', 'sources/' || source.canonical_source_id || '/files/' || file.id ||
                 CASE WHEN file.mime_type = 'application/pdf' THEN '.pdf' ELSE '.snapshot' END,
              'mediaType', file.mime_type, 'contentHash', 'sha256:' || file.checksum_sha256
            ) ORDER BY file.id) FILTER (WHERE file.id IS NOT NULL), '[]'::jsonb) AS canonical_files
     FROM sources source LEFT JOIN files file ON file.source_id = source.id AND file.deleted_at IS NULL
     WHERE source.id = $1 AND source.deleted_at IS NULL
      GROUP BY source.id`, [candidate.source_id],
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
  if (isSnapshotSpellContent(content)) {
    const evidence = currentSnapshotEvidence(candidate);
    if (!evidence) throw new ImportReviewError("Collector spell has no complete persisted occurrence and database file evidence.", 409);
    try {
      return projectSnapshotSpellCandidate(content, {
        candidateKey: candidate.candidate_key,
        createdAt: iso(candidate.created_at),
        source,
        fileId: candidate.file_id,
        evidence,
      });
    } catch (error) {
      if (error instanceof CandidateProjectionError) throw new ImportReviewError(error.message);
      throw error;
    }
  }
  if (!candidate.entry_type || !candidate.generation_id || !candidate.chunk_id || candidate.chunk_index === null || !candidate.quote_text) {
    throw new ImportReviewError("Publishable extracted candidates require typed source, generation, and chunk provenance.");
  }
  try {
    return projectExtractedCandidate(content, {
      candidateKey: candidate.candidate_key,
      entryType: candidate.entry_type as CompendiumEntryType,
      createdAt: iso(candidate.created_at),
      boundary: {
        sourceId: candidate.source_id,
        fileId: candidate.file_id,
        generationId: candidate.generation_id,
        edition: source.edition,
        language: source.language,
        accessTier: source.accessTier,
        shared: source.shared,
        ownerUserId: source.ownerUserId,
      },
      source,
      chunk: {
        id: candidate.chunk_id,
        chunkIndex: candidate.chunk_index,
        pageNumber: candidate.page_number,
        sectionHeading: candidate.section_heading,
        quoteText: candidate.quote_text,
      },
    });
  } catch (error) {
    if (error instanceof CandidateProjectionError) throw new ImportReviewError(error.message);
    throw error;
  }
}

async function buildPreviousRevision(client: DbClient, row: CandidateRow): Promise<CanonicalRevision> {
  const evidence = previousEvidence(row);
  const content = previousPublishedContent(row);
  const collector = isSnapshotSpellContent(content ?? {});
  if ((!evidence && !collector) || !content || !row.previous_created_at || !row.previous_candidate_key || !row.previous_entry_type) {
    throw new ImportReviewError("Missing candidate has no complete previous publication evidence.", 409);
  }
  return buildRevision(client, {
    ...row,
    candidate_key: row.previous_candidate_key,
    entry_type: row.previous_entry_type,
    generation_id: evidence?.generationId ?? row.previous_generation_id,
    chunk_id: evidence?.chunkId ?? null,
    chunk_index: evidence?.chunkIndex ?? null,
    page_number: evidence?.page ?? null,
    section_heading: evidence?.sectionHeading ?? null,
    quote_text: evidence?.quoteText ?? null,
    locator: row.previous_locator,
    occurrence_fingerprint_sha256: row.previous_fingerprint_sha256,
    occurrence_raw_blob_path: row.previous_raw_blob_path,
    occurrence_source_fetched_at: row.previous_source_fetched_at,
    created_at: row.previous_created_at,
  }, content);
}

function mapCandidate(row: CandidateRow): ImportCandidateReview {
  const evidence = row.diff_status === "missing" ? previousEvidence(row) : currentEvidence(row);
  return { id: row.id, candidateKey: row.candidate_key, entryId: null, entryType: row.entry_type, diffStatus: row.diff_status,
    content: row.content, previousContent: row.previous_content, invalidReason: row.invalid_reason, locator: evidence?.locator ?? row.locator,
    chunkId: evidence?.chunkId ?? null, page: evidence?.page ?? null,
    evidenceSourceId: evidence?.sourceId ?? null, evidenceFileId: evidence?.fileId ?? null, evidenceGenerationId: evidence?.generationId ?? null,
    activeRevisionToken: null, decision: row.decision ?? "pending", resolvedContent: row.resolved_content,
    payloadOrigin: "unknown", publicationCapability: "requires_extraction", publicationBlockReason: null,
    publicationStatus: row.publication_status ?? "idle", lastError: row.last_error, reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at == null ? null : iso(row.reviewed_at) };
}

function candidateCapability(row: CandidateRow): CandidatePublicationCapability {
  if (row.diff_status === "missing") return missingCandidateCapability(row);
  return classifyCandidatePublication(row.content, capabilityContext(row, currentEvidence(row)));
}

function missingCandidateCapability(row: CandidateRow): CandidatePublicationCapability {
  const fallback = classifyCandidatePublication(row.previous_content, capabilityContext(row, previousEvidence(row)));
  const chainError = previousChainError(row);
  if (chainError) return blockedCapability(fallback, chainError);
  const content = previousPublishedContent(row);
  if (!content) return blockedCapability(fallback, "Previous candidate has no completed approved or merged publication.");
  const capability = classifyCandidatePublication(content, capabilityContext(row, previousEvidence(row)));
  if (capability.publicationCapability !== "publishable") return capability;
  return { ...capability, publicationCapability: "can_unpublish" };
}

function capabilityContext(row: CandidateRow, evidence: ReturnType<typeof currentEvidence>) {
  return {
    candidateKey: row.candidate_key,
    entryType: row.entry_type,
    sourceId: row.source_id,
    fileId: row.file_id,
    generationId: evidence?.generationId ?? null,
    edition: row.edition,
    language: row.language,
    accessTier: row.access_tier,
    shared: row.shared,
    ownerUserId: row.owner_user_id,
    chunk: evidence
      ? { id: evidence.chunkId, chunkIndex: evidence.chunkIndex, pageNumber: evidence.page, sectionHeading: evidence.sectionHeading, quoteText: evidence.quoteText }
      : null,
    snapshotEvidence: row.diff_status === "missing" ? previousSnapshotEvidence(row) : currentSnapshotEvidence(row),
  };
}

function currentEvidence(row: CandidateRow) {
  return row.chunk_id && row.chunk_index !== null && row.quote_text && row.generation_id
    ? { sourceId: row.source_id, fileId: row.file_id, generationId: row.generation_id, locator: row.locator, chunkId: row.chunk_id,
      chunkIndex: row.chunk_index, page: row.page_number, sectionHeading: row.section_heading, quoteText: row.quote_text }
    : null;
}

function previousEvidence(row: CandidateRow) {
  return row.previous_source_id && row.previous_file_id && row.previous_generation_id && row.previous_locator
    && row.previous_chunk_id && row.previous_chunk_index !== null && row.previous_quote_text
    ? { sourceId: row.previous_source_id, fileId: row.previous_file_id, generationId: row.previous_generation_id,
      locator: row.previous_locator, chunkId: row.previous_chunk_id, chunkIndex: row.previous_chunk_index,
      page: row.previous_page_number, sectionHeading: row.previous_section_heading, quoteText: row.previous_quote_text }
    : null;
}

function previousChainError(row: CandidateRow): string | null {
  const collector = isSnapshotSpellContent(previousPublishedContent(row) ?? row.previous_content ?? {});
  if (row.occurrence_id !== null || !row.previous_candidate_id || !row.previous_occurrence_id
      || (collector ? !previousSnapshotEvidence(row) : !previousEvidence(row))) {
    return `Missing candidate has no complete previous occurrence and ${collector ? "collector" : "chunk"} evidence chain.`;
  }
  if (row.previous_source_id !== row.source_id || row.previous_file_id !== row.file_id
      || row.previous_entry_type !== row.entry_type || row.previous_candidate_key !== row.candidate_key) {
    return "Previous candidate source, file, type, and key must match the missing candidate.";
  }
  if (!row.content_sha256 || row.content_sha256 !== row.previous_content_sha256) {
    return "Missing candidate content must retain the immutable previous candidate payload.";
  }
  return null;
}

function currentSnapshotEvidence(row: CandidateRow): SnapshotSpellEvidence | null {
  return snapshotEvidence(row.locator, row.occurrence_fingerprint_sha256, row.occurrence_raw_blob_path,
    row.occurrence_source_fetched_at, row.file_checksum_sha256);
}

function previousSnapshotEvidence(row: CandidateRow): SnapshotSpellEvidence | null {
  return snapshotEvidence(row.previous_locator, row.previous_fingerprint_sha256, row.previous_raw_blob_path,
    row.previous_source_fetched_at, row.file_checksum_sha256);
}

function snapshotEvidence(
  sourceUrl: string | null,
  fingerprintSha256: string | null,
  rawBlobPath: string | null,
  fetchedAt: Date | string | null,
  fileChecksumSha256: string | null,
): SnapshotSpellEvidence | null {
  if (!sourceUrl || !fingerprintSha256 || !rawBlobPath || !fetchedAt || !fileChecksumSha256
      || rawBlobPath !== `blobs/${fingerprintSha256}.html`) return null;
  return { sourceUrl, fingerprintSha256, rawBlobPath, fetchedAt: iso(fetchedAt), fileChecksumSha256 };
}

function lockCollectorSpellMerge(row: CandidateRow, resolved: Record<string, unknown>): Record<string, unknown> {
  if (!isSnapshotSpellContent(row.content)) return resolved;
  if (!isSnapshotSpellContent(resolved)) throw new ImportReviewError("Collector spell merge must retain the snapshot candidate envelope.", 409);
  for (const field of ["schemaVersion", "kind", "externalId", "sourceUrl", "sha256", "parserVersion", "title", "aliases", "body", "sourceVersion"] as const) {
    if (JSON.stringify(resolved[field]) !== JSON.stringify(row.content[field])) {
      throw new ImportReviewError(`Collector spell merge cannot modify immutable ${field} evidence.`, 409);
    }
  }
  return resolved;
}

function previousPublishedContent(row: CandidateRow): Record<string, unknown> | null {
  if (row.previous_publication_status !== "completed") return null;
  if (row.previous_decision === "approved") return row.previous_content;
  if (row.previous_decision === "merged" && isRecord(row.previous_resolved_content)) return row.previous_resolved_content;
  return null;
}

function blockedCapability(capability: CandidatePublicationCapability, reason: string): CandidatePublicationCapability {
  return { ...capability, publicationCapability: "requires_extraction", publicationBlockReason: reason };
}

function candidateEntryId(row: Pick<CandidateRow, "entry_type" | "candidate_key">): string | null {
  if (!row.entry_type) return null;
  try {
    return canonicalCandidateEntryId(row.entry_type, row.candidate_key);
  } catch {
    return null;
  }
}

function requiredCandidateEntryId(row: Pick<CandidateRow, "entry_type" | "candidate_key">): string {
  const entryId = candidateEntryId(row);
  if (!entryId) throw new ImportReviewError("Candidate has no supported type-qualified canonical identity.");
  return entryId;
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
  if (decision === "merged" && diffStatus === "missing") throw new ImportReviewError("Missing candidates cannot be merged as new content.");
  if (decision === "unpublish" && diffStatus !== "missing") throw new ImportReviewError("Only missing candidates can be unpublished.");
}

function reviewIdempotencyKey(runId: string, candidateId: string, attempt: number): string {
  return `review-${runId.replaceAll("-", "")}-${candidateId.replaceAll("-", "")}-${attempt}`;
}

async function audit(client: DbClient, runId: string, candidateId: string, event: string, actor: string, initiatingActor: string | null, details: Record<string, unknown>): Promise<void> {
  await client.query(`INSERT INTO compendium_import_review_audit (import_run_id, candidate_id, event_type, actor, initiating_actor, details) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [runId, candidateId, event, actor, initiatingActor, JSON.stringify(details)]);
}

function requireMatchingCapturedExpectation(row: CandidateRow, displayedToken: string | null): string | null {
  if (!row.expected_active_revision_captured) throw new ImportReviewError("Publication retry is missing its captured active revision.", 409);
  if (row.expected_active_revision_id !== displayedToken) {
    throw new ImportReviewError("The displayed active revision changed after this pending command was created. Reload before retrying.", 409);
  }
  return row.expected_active_revision_id;
}

async function defaultActiveRevisionReader(entryIds: readonly string[]): Promise<ReadonlyMap<string, string | null>> {
  const { manifest } = await loadResolvedRepositoryManifest(getDataRoot());
  const active = new Map(manifest.entries.map((entry) => [entry.entryId, entry.revisionId]));
  return new Map(entryIds.map((entryId) => [entryId, active.get(entryId) ?? null]));
}

function validateActiveRevisionTokens(tokens: Readonly<Record<string, string | null>> | undefined, candidateIds: readonly string[]): void {
  if (!tokens || !isRecord(tokens)) throw new ImportReviewError("activeRevisionTokens must contain every selected candidate.");
  const keys = Object.keys(tokens).sort();
  const expected = [...candidateIds].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ImportReviewError("activeRevisionTokens must contain exactly every selected candidate ID.");
  }
  for (const token of Object.values(tokens)) {
    if (token !== null && (typeof token !== "string" || !/^rev-[0-9a-f]{64}$/.test(token))) {
      throw new ImportReviewError("Each active revision token must be a revision ID or null.");
    }
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value!)) : fallback;
}
function requireUuid(value: string, name: string): void { if (!UUID.test(value)) throw new ImportReviewError(`${name} must be a UUID.`); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isSnapshotSpellContent(value: Record<string, unknown>): boolean { return value.kind === "snapshotSpellCandidate" && value.schemaVersion === 1; }
function number(value: unknown): number { return Number(value ?? 0); }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 4000) : "Publication failed."; }
