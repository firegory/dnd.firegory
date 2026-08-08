import { createHash } from "node:crypto";

import type { QueryResultRow } from "pg";

import { withTransaction } from "../db/client.ts";
import { COMPENDIUM_ENTRY_TYPES, CompendiumValidationError } from "./service.ts";

type DbClient = Readonly<{
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}>;
type TransactionRunner = <T>(callback: (client: DbClient) => Promise<T>) => Promise<T>;

export type ImportRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type ImportDiffStatus = "new" | "unchanged" | "changed" | "missing" | "duplicate" | "invalid";
export const IMPORT_CANDIDATE_ENTRY_TYPES = [...COMPENDIUM_ENTRY_TYPES, "guide"] as const;
export type ImportCandidateEntryType = (typeof IMPORT_CANDIDATE_ENTRY_TYPES)[number];

type RunRow = Readonly<{
  id: string;
  source_id: string;
  file_id: string;
  generation_id: string | null;
  status: ImportRunStatus;
  checkpoint: "created" | "occurrences" | "diffed" | "completed";
  lease_token: string | null;
  allowed_review_entry_types: ImportCandidateEntryType[] | null;
}>;

export type ImportRun = Readonly<{
  id: string;
  sourceId: string;
  fileId: string;
  generationId: string | null;
  status: ImportRunStatus;
  checkpoint: RunRow["checkpoint"];
}>;

export type CreateImportRunInput = Readonly<{
  id?: string;
  sourceId: string;
  fileId: string;
  generationId?: string | null;
  ingestionJobId?: string | null;
  importer: string;
  importerVersion: string;
  parserVersion: string;
  promptVersion: string;
  modelVersion: string;
  inputSha256: string;
  allowedReviewEntryTypes?: readonly ImportCandidateEntryType[] | null;
  actor: string;
}>;

export type ImportOccurrenceInput = Readonly<{
  occurrenceIndex: number;
  locator: string;
  fingerprintSha256: string;
  chunkId?: string | null;
  rawBlobPath?: string | null;
  sourceFetchedAt?: string | null;
  indexLocator?: string | null;
  indexFingerprintSha256?: string | null;
  rawIndexBlobPath?: string | null;
  indexSourceFetchedAt?: string | null;
  indexCardFingerprintSha256?: string | null;
  metadataEvidenceText?: string | null;
}>;

export type ImportCandidateInput = Readonly<{
  occurrenceIndex: number;
  candidateKey?: string | null;
  entryType?: ImportCandidateEntryType | null;
  content: Readonly<Record<string, unknown>>;
  invalidReason?: string | null;
}>;

export type ImportCandidate = Readonly<{
  id: string;
  candidateKey: string;
  diffStatus: ImportDiffStatus;
  contentSha256: string;
}>;

type CandidateRow = Readonly<{
  id: string;
  import_run_id: string;
  source_id: string;
  file_id: string;
  generation_id: string | null;
  occurrence_id: string | null;
  previous_candidate_id: string | null;
  candidate_order: number;
  candidate_key: string;
  entry_type: ImportCandidateEntryType | null;
  diff_status: ImportDiffStatus;
  content: Record<string, unknown>;
  content_sha256: string;
  invalid_reason: string | null;
  created_at: string | Date;
}>;

type BaselineCandidateRow = Pick<CandidateRow, "id" | "candidate_key" | "entry_type" | "content" | "content_sha256">;

type OccurrenceRow = Readonly<{
  id: string;
  import_run_id: string;
  source_id: string;
  file_id: string;
  generation_id: string | null;
  chunk_id: string | null;
  occurrence_index: number;
  locator: string;
  fingerprint_sha256: string;
  raw_blob_path: string | null;
  source_fetched_at: string | Date | null;
  index_locator: string | null;
  index_fingerprint_sha256: string | null;
  raw_index_blob_path: string | null;
  index_source_fetched_at: string | Date | null;
  index_card_fingerprint_sha256: string | null;
  metadata_evidence_text: string | null;
  created_at: string | Date;
}>;

export class ImportRunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRunConflictError";
  }
}

export class CompendiumImportRunService {
  private readonly transaction: TransactionRunner;

  constructor(transaction: TransactionRunner = withTransaction as TransactionRunner) {
    this.transaction = transaction;
  }

  async createRun(input: CreateImportRunInput): Promise<ImportRun> {
    validateRunInput(input);
    return this.transaction(async (client) => {
      const file = (await client.query<{ id: string }>(
        `SELECT id FROM files
         WHERE id = $1 AND source_id = $2 AND deleted_at IS NULL
         FOR SHARE`,
        [input.fileId, input.sourceId],
      )).rows[0];
      if (!file) throw new CompendiumValidationError("The file is outside the requested source boundary.");

      let normalizedJobId = input.ingestionJobId ?? null;
      if (input.generationId != null) {
        const generation = (await client.query<{ ingestion_job_id: string | null }>(
          `SELECT ingestion_job_id FROM ingestion_generations
           WHERE id = $1 AND file_id = $2 AND source_id = $3
           FOR SHARE`,
          [input.generationId, input.fileId, input.sourceId],
        )).rows[0];
        if (!generation) throw new CompendiumValidationError("The generation is outside the requested source boundary.");
        if (input.ingestionJobId != null && generation.ingestion_job_id !== input.ingestionJobId) {
          throw new CompendiumValidationError("The generation does not belong to the requested ingestion job.");
        }
        normalizedJobId = generation.ingestion_job_id;
      }
      if (normalizedJobId != null) {
        const job = (await client.query<{ id: string }>(
          `SELECT id FROM ingestion_jobs
           WHERE id = $1 AND file_id = $2 AND source_id = $3
           FOR SHARE`,
          [normalizedJobId, input.fileId, input.sourceId],
        )).rows[0];
        if (!job) throw new CompendiumValidationError("The ingestion job is outside the requested source boundary.");
      }

      const allowedReviewEntryTypes = input.allowedReviewEntryTypes ? [...input.allowedReviewEntryTypes] : null;
      const values = [
        input.sourceId, input.fileId, input.generationId ?? null, normalizedJobId,
        input.importer.trim(), input.importerVersion.trim(), input.parserVersion.trim(),
        input.promptVersion.trim(), input.modelVersion.trim(), input.inputSha256, input.id ?? null, allowedReviewEntryTypes,
      ];
      const inserted = await client.query<RunRow>(
        `INSERT INTO compendium_import_runs
           (id, source_id, file_id, generation_id, ingestion_job_id, importer, importer_version,
              parser_version, prompt_version, model_version, input_sha256, allowed_review_entry_types)
          VALUES (coalesce($11::uuid, gen_random_uuid()),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12::compendium_entry_type[])
         ON CONFLICT DO NOTHING
         RETURNING id, source_id, file_id, generation_id, ingestion_job_id, status, checkpoint, lease_token, allowed_review_entry_types`,
        values,
      );
      let row = inserted.rows[0];
      if (!row) {
        row = (await client.query<RunRow>(
          `SELECT id, source_id, file_id, generation_id, ingestion_job_id, status, checkpoint, lease_token, allowed_review_entry_types
           FROM compendium_import_runs
            WHERE source_id = $1 AND file_id = $2 AND generation_id IS NOT DISTINCT FROM $3
              AND ($3::uuid IS NOT NULL OR ingestion_job_id IS NOT DISTINCT FROM $4)
              AND importer = $5 AND importer_version = $6 AND parser_version = $7
              AND prompt_version = $8 AND model_version = $9 AND input_sha256 = $10`,
          values.slice(0, 10),
        )).rows[0];
      }
      if (!row) throw new CompendiumValidationError("The file, generation, or ingestion job is outside the requested source boundary.");
      if (!sameReviewScope(row.allowed_review_entry_types ?? null, allowedReviewEntryTypes)) throw new CompendiumValidationError("The existing import run has a different allowed review entry-type scope.");
      if (inserted.rows[0]) {
        await client.query(
          `INSERT INTO compendium_import_audit (import_run_id, event_type, to_status, actor, details)
           VALUES ($1, 'created', 'pending', $2, $3::jsonb)`,
          [row.id, input.actor.trim(), JSON.stringify({ inputSha256: input.inputSha256 })],
        );
      }
      return runFromRow(row);
    });
  }

  async claimRun(runId: string, actor: string, leaseMilliseconds = 300_000): Promise<Readonly<{
    run: ImportRun;
    leaseToken: string | null;
    completed: boolean;
  }>> {
    requireUuid(runId, "runId");
    requireText(actor, "actor");
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1_000 || leaseMilliseconds > 86_400_000) {
      throw new CompendiumValidationError("leaseMilliseconds must be between 1000 and 86400000.");
    }
    return this.transaction(async (client) => {
      const current = requiredRow((await client.query<RunRow & { lease_active: boolean }>(
        `SELECT id, source_id, file_id, generation_id, status, checkpoint, lease_token, allowed_review_entry_types,
                coalesce(lease_expires_at > now(), false) AS lease_active
         FROM compendium_import_runs WHERE id = $1 FOR UPDATE`,
        [runId],
      )).rows[0], "Import run was not found.");
      if (current.status === "succeeded") return { run: runFromRow(current), leaseToken: null, completed: true };
      if (current.status === "cancelled") throw new ImportRunConflictError("A cancelled import run cannot be resumed.");
      if (current.status === "running" && current.lease_active) throw new ImportRunConflictError("Import run is already leased by another worker.");

      const claimed = requiredRow((await client.query<RunRow>(
        `UPDATE compendium_import_runs
         SET status = 'running', started_at = coalesce(started_at, now()), finished_at = NULL,
             lease_token = gen_random_uuid(), lease_expires_at = now() + $2 * interval '1 millisecond',
             heartbeat_at = now()
         WHERE id = $1
         RETURNING id, source_id, file_id, generation_id, status, checkpoint, lease_token, allowed_review_entry_types`,
        [runId, leaseMilliseconds],
      )).rows[0], "Unable to claim import run.");
      await client.query(
        `INSERT INTO compendium_import_audit (import_run_id, event_type, from_status, to_status, actor, details)
         VALUES ($1, 'claimed', $2, 'running', $3, $4::jsonb)`,
        [runId, current.status, actor.trim(), JSON.stringify({ resumed: current.status !== "pending" })],
      );
      return { run: runFromRow(claimed), leaseToken: claimed.lease_token, completed: false };
    });
  }

  async heartbeat(runId: string, leaseToken: string, leaseMilliseconds = 300_000): Promise<void> {
    requireUuid(runId, "runId"); requireUuid(leaseToken, "leaseToken");
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1_000 || leaseMilliseconds > 86_400_000) {
      throw new CompendiumValidationError("leaseMilliseconds must be between 1000 and 86400000.");
    }
    const updated = await this.transaction((client) => client.query(
      `UPDATE compendium_import_runs
       SET heartbeat_at = now(), lease_expires_at = now() + $3 * interval '1 millisecond'
       WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()`,
      [runId, leaseToken, leaseMilliseconds],
    ));
    if (updated.rowCount !== 1) throw new ImportRunConflictError("Import run lease is missing or expired.");
  }

  async recordOccurrences(runId: string, leaseToken: string, occurrences: readonly ImportOccurrenceInput[], actor: string): Promise<void> {
    validateLeaseArguments(runId, leaseToken, actor);
    const indexes = new Set<number>();
    for (const occurrence of occurrences) {
      if (!Number.isSafeInteger(occurrence.occurrenceIndex) || occurrence.occurrenceIndex < 0 || occurrence.occurrenceIndex > 2_147_483_647) throw new CompendiumValidationError("occurrenceIndex must fit a nonnegative PostgreSQL integer.");
      if (indexes.has(occurrence.occurrenceIndex)) throw new CompendiumValidationError("occurrenceIndex values must be unique in a batch.");
      indexes.add(occurrence.occurrenceIndex);
      requireText(occurrence.locator, "locator"); requireHash(occurrence.fingerprintSha256, "fingerprintSha256");
      if (occurrence.chunkId != null) requireUuid(occurrence.chunkId, "chunkId");
      validateRawOccurrenceEvidence(occurrence);
    }
    await this.transaction(async (client) => {
      const run = await lockLeasedRun(client, runId, leaseToken);
      if (run.checkpoint !== "created" && run.checkpoint !== "occurrences") {
        throw new ImportRunConflictError("Occurrences cannot be recorded after candidate diffing has started.");
      }
      for (const occurrence of occurrences) {
        const values = [runId, run.source_id, run.file_id, run.generation_id, occurrence.chunkId ?? null, occurrence.occurrenceIndex, occurrence.locator.trim(), occurrence.fingerprintSha256,
          occurrence.rawBlobPath ?? null, occurrence.sourceFetchedAt ?? null, occurrence.indexLocator ?? null,
          occurrence.indexFingerprintSha256 ?? null, occurrence.rawIndexBlobPath ?? null, occurrence.indexSourceFetchedAt ?? null,
          occurrence.indexCardFingerprintSha256 ?? null, occurrence.metadataEvidenceText ?? null];
        const inserted = await client.query<OccurrenceRow>(
          `INSERT INTO compendium_import_occurrences
              (import_run_id, source_id, file_id, generation_id, chunk_id, occurrence_index, locator, fingerprint_sha256, raw_blob_path, source_fetched_at,
               index_locator, index_fingerprint_sha256, raw_index_blob_path, index_source_fetched_at, index_card_fingerprint_sha256, metadata_evidence_text)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (import_run_id, occurrence_index) DO NOTHING
           RETURNING id, import_run_id, source_id, file_id, generation_id, chunk_id,
                       occurrence_index, locator, fingerprint_sha256, raw_blob_path, source_fetched_at,
                       index_locator, index_fingerprint_sha256, raw_index_blob_path, index_source_fetched_at,
                       index_card_fingerprint_sha256, metadata_evidence_text, created_at`,
          values,
        );
        let persisted = inserted.rows[0];
        if (!persisted) {
          persisted = (await client.query<OccurrenceRow>(
            `SELECT id, import_run_id, source_id, file_id, generation_id, chunk_id,
                     occurrence_index, locator, fingerprint_sha256, raw_blob_path, source_fetched_at,
                     index_locator, index_fingerprint_sha256, raw_index_blob_path, index_source_fetched_at,
                     index_card_fingerprint_sha256, metadata_evidence_text, created_at
             FROM compendium_import_occurrences
             WHERE import_run_id = $1 AND occurrence_index = $2`,
            [runId, occurrence.occurrenceIndex],
          )).rows[0];
        }
        if (!persisted || !occurrenceMatches(persisted, run, occurrence)) {
          throw new ImportRunConflictError(`Occurrence ${occurrence.occurrenceIndex} was already recorded with different immutable content.`);
        }
        await insertCheckpoint(
          client,
          runId,
          `occurrence:${occurrence.occurrenceIndex}`,
          sha256Json(occurrenceManifest(persisted)),
          { occurrenceIndex: occurrence.occurrenceIndex },
        );
      }
      await client.query(
        `UPDATE compendium_import_runs SET checkpoint = CASE WHEN checkpoint = 'created' THEN 'occurrences' ELSE checkpoint END,
           occurrence_count = (SELECT count(*)::integer FROM compendium_import_occurrences WHERE import_run_id = $1)
         WHERE id = $1`,
        [runId],
      );
      await audit(client, runId, "occurrences_recorded", actor, { batchSize: occurrences.length });
    });
  }

  async computeCandidateDiff(runId: string, leaseToken: string, candidates: readonly ImportCandidateInput[], actor: string): Promise<readonly ImportCandidate[]> {
    validateLeaseArguments(runId, leaseToken, actor);
    const occurrenceIndexes = new Set<number>();
    for (const candidate of candidates) {
      if (!Number.isSafeInteger(candidate.occurrenceIndex) || candidate.occurrenceIndex < 0) throw new CompendiumValidationError("Candidate occurrenceIndex must be nonnegative.");
      if (occurrenceIndexes.has(candidate.occurrenceIndex)) throw new CompendiumValidationError("Each occurrence can produce at most one candidate.");
      occurrenceIndexes.add(candidate.occurrenceIndex);
      requireObject(candidate.content, "candidate.content");
    }

    return this.transaction(async (client) => {
      const run = await lockLeasedRun(client, runId, leaseToken);
      if (run.checkpoint !== "occurrences" && run.checkpoint !== "diffed") {
        throw new ImportRunConflictError("The occurrence phase must finish before candidate diffing.");
      }
      const occurrences = await client.query<OccurrenceRow>(
        `SELECT id, import_run_id, source_id, file_id, generation_id, chunk_id,
                 occurrence_index, locator, fingerprint_sha256, raw_blob_path, source_fetched_at,
                 index_locator, index_fingerprint_sha256, raw_index_blob_path, index_source_fetched_at,
                 index_card_fingerprint_sha256, metadata_evidence_text, created_at
         FROM compendium_import_occurrences
         WHERE import_run_id = $1 ORDER BY occurrence_index, id`,
        [runId],
      );
      const occurrenceByIndex = new Map(occurrences.rows.map((row) => [row.occurrence_index, row.id]));
      if (run.checkpoint === "diffed") {
        const persisted = await loadCandidateRows(client, runId);
        if (!candidateReplayMatches(persisted, run, candidates, occurrenceByIndex)) {
          throw new ImportRunConflictError("Persisted candidate diff does not match the canonical replay.");
        }
        const diffHash = sha256Json({
          occurrences: occurrences.rows.map(occurrenceManifest),
          candidates: persisted.map(candidateManifest),
        });
        await verifyCheckpoint(client, runId, "candidate-diff", diffHash, {
          candidateCount: persisted.length,
          occurrenceCount: occurrences.rows.length,
        });
        return candidatesFromRows(persisted);
      }

      const baselineRows = await client.query<BaselineCandidateRow>(
        `SELECT DISTINCT ON (candidate.entry_type, candidate.candidate_key)
                candidate.id, candidate.candidate_key, candidate.entry_type,
                candidate.content, candidate.content_sha256
         FROM compendium_import_candidates candidate
         JOIN compendium_import_runs previous_run ON previous_run.id = candidate.import_run_id
         WHERE previous_run.source_id = $1 AND previous_run.file_id = $2
           AND previous_run.id <> $3 AND previous_run.status = 'succeeded'
           AND candidate.diff_status IN ('new', 'unchanged', 'changed')
         ORDER BY candidate.entry_type, candidate.candidate_key, previous_run.finished_at DESC, candidate.created_at DESC`,
        [run.source_id, run.file_id, runId],
      );
      const baseline = new Map(baselineRows.rows.map((row) => [candidateIdentity(row.entry_type!, row.candidate_key), row]));
      const seen = new Set<string>();
      const present = new Set<string>();
      const planned: Array<Readonly<{
        candidateOrder: number; occurrenceId: string | null; previous: BaselineCandidateRow | null; key: string; type: ImportCandidateEntryType | null;
        status: ImportDiffStatus; content: Record<string, unknown>; hash: string; invalidReason: string | null;
      }>> = [];

      for (const candidate of candidates) {
        const occurrenceId = occurrenceByIndex.get(candidate.occurrenceIndex);
        if (!occurrenceId) throw new CompendiumValidationError(`Occurrence ${candidate.occurrenceIndex} has not been recorded.`);
        const key = candidate.candidateKey?.trim() ?? "";
        const type = candidate.entryType ?? null;
        const invalidReason = candidate.invalidReason?.trim()
          || (!validCandidateKey(key) ? "candidateKey must be a stable lowercase key" : null)
          || (!type || !IMPORT_CANDIDATE_ENTRY_TYPES.includes(type) ? "entryType is unsupported" : null);
        const hash = sha256Json(candidate.content);
        if (invalidReason) {
          planned.push({ candidateOrder: planned.length, occurrenceId, previous: null, key: key || `invalid:${candidate.occurrenceIndex}`, type, status: "invalid", content: candidate.content, hash, invalidReason });
          continue;
        }
        const identity = candidateIdentity(type!, key);
        present.add(identity);
        if (seen.has(identity)) {
          planned.push({ candidateOrder: planned.length, occurrenceId, previous: null, key, type, status: "duplicate", content: candidate.content, hash, invalidReason: null });
          continue;
        }
        seen.add(identity);
        const previous = baseline.get(identity) ?? null;
        const status: ImportDiffStatus = !previous ? "new" : previous.content_sha256 === hash && previous.entry_type === type ? "unchanged" : "changed";
        planned.push({ candidateOrder: planned.length, occurrenceId, previous, key, type, status, content: candidate.content, hash, invalidReason: null });
      }
      for (const [identity, previous] of baseline) {
        if (!present.has(identity)) planned.push({ candidateOrder: planned.length, occurrenceId: null, previous, key: previous.candidate_key, type: previous.entry_type, status: "missing", content: previous.content, hash: previous.content_sha256, invalidReason: null });
      }

      for (const candidate of planned) {
        const inserted = await client.query<CandidateRow>(
          `INSERT INTO compendium_import_candidates
             (import_run_id, source_id, file_id, generation_id, occurrence_id, previous_candidate_id,
              candidate_order, candidate_key, entry_type, diff_status, content, content_sha256, invalid_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
            ON CONFLICT (import_run_id, entry_type, candidate_key, occurrence_id) DO NOTHING
           RETURNING id, import_run_id, source_id, file_id, generation_id, occurrence_id,
                     previous_candidate_id, candidate_order, candidate_key, entry_type, diff_status,
                     content, content_sha256, invalid_reason, created_at`,
          [runId, run.source_id, run.file_id, run.generation_id, candidate.occurrenceId, candidate.previous?.id ?? null,
            candidate.candidateOrder, candidate.key, candidate.type, candidate.status, canonicalJson(candidate.content), candidate.hash, candidate.invalidReason],
        );
        let persisted = inserted.rows[0];
        if (!persisted) {
          persisted = (await client.query<CandidateRow>(
            `SELECT id, import_run_id, source_id, file_id, generation_id, occurrence_id,
                    previous_candidate_id, candidate_order, candidate_key, entry_type, diff_status,
                    content, content_sha256, invalid_reason, created_at
             FROM compendium_import_candidates
             WHERE import_run_id = $1 AND entry_type IS NOT DISTINCT FROM $2
               AND candidate_key = $3 AND occurrence_id IS NOT DISTINCT FROM $4`,
            [runId, candidate.type, candidate.key, candidate.occurrenceId],
          )).rows[0];
        }
        if (!persisted || !candidateMatches(persisted, run, candidate)) {
          throw new ImportRunConflictError(`Candidate ${candidate.key} was already recorded with different immutable content.`);
        }
      }

      const persisted = await loadCandidateRows(client, runId);
      if (persisted.length !== planned.length || persisted.some((row, index) => !candidateMatches(row, run, planned[index]))) {
        throw new ImportRunConflictError("Persisted candidate diff does not match the canonical replay.");
      }
      const diffHash = sha256Json({
        occurrences: occurrences.rows.map(occurrenceManifest),
        candidates: persisted.map(candidateManifest),
      });
      const details = { candidateCount: persisted.length, occurrenceCount: occurrences.rows.length };
      await insertCheckpoint(client, runId, "candidate-diff", diffHash, details);
      await refreshCounters(client, runId, "diffed");
      await audit(client, runId, "candidate_diff_computed", actor, { ...details, contentSha256: diffHash });
      return candidatesFromRows(persisted);
    });
  }

  async addDiagnostic(runId: string, leaseToken: string, input: Readonly<{
    diagnosticKey: string;
    level: "info" | "warning" | "error";
    code: string;
    message: string;
    details?: Readonly<Record<string, unknown>>;
    actor: string;
  }>): Promise<void> {
    validateLeaseArguments(runId, leaseToken, input.actor);
    requireText(input.diagnosticKey, "diagnosticKey"); requireText(input.code, "code"); requireText(input.message, "message");
    requireObject(input.details ?? {}, "details");
    await this.transaction(async (client) => {
      await lockLeasedRun(client, runId, leaseToken);
      const inserted = await client.query<{ level: string; code: string; message: string; details: Record<string, unknown> }>(
        `INSERT INTO compendium_import_diagnostics (import_run_id, diagnostic_key, level, code, message, details)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (import_run_id, diagnostic_key) DO NOTHING
         RETURNING level, code, message, details`,
        [runId, input.diagnosticKey.trim(), input.level, input.code.trim(), input.message.trim(), canonicalJson(input.details ?? {})],
      );
      if (!inserted.rows[0]) {
        const existing = (await client.query<{ level: string; code: string; message: string; details: Record<string, unknown> }>(
          `SELECT level, code, message, details FROM compendium_import_diagnostics
           WHERE import_run_id = $1 AND diagnostic_key = $2`,
          [runId, input.diagnosticKey.trim()],
        )).rows[0];
        if (!existing || existing.level !== input.level || existing.code !== input.code.trim()
          || existing.message !== input.message.trim() || canonicalJson(existing.details) !== canonicalJson(input.details ?? {})) {
          throw new ImportRunConflictError(`Diagnostic ${input.diagnosticKey.trim()} was already recorded with different immutable content.`);
        }
      }
      await client.query(
        `UPDATE compendium_import_runs SET diagnostic_count =
           (SELECT count(*)::integer FROM compendium_import_diagnostics WHERE import_run_id = $1)
         WHERE id = $1`,
        [runId],
      );
      await audit(client, runId, "diagnostic_recorded", input.actor, { diagnosticKey: input.diagnosticKey.trim() });
    });
  }

  async completeRun(runId: string, leaseToken: string, actor: string): Promise<void> {
    validateLeaseArguments(runId, leaseToken, actor);
    await this.transaction(async (client) => {
      const run = await lockLeasedRun(client, runId, leaseToken);
      if (run.checkpoint !== "diffed") throw new ImportRunConflictError("Candidate diff must be durable before an import run can succeed.");
      const diffCheckpoint = requiredRow((await client.query<{ content_sha256: string }>(
        "SELECT content_sha256 FROM compendium_import_checkpoints WHERE import_run_id = $1 AND checkpoint_key = 'candidate-diff'",
        [runId],
      )).rows[0], "Candidate diff checkpoint was not found.");
      await insertCheckpoint(client, runId, "completed", diffCheckpoint.content_sha256, {});
      await refreshCounters(client, runId, "completed");
      const updated = await client.query(
        `UPDATE compendium_import_runs
         SET status = 'succeeded', checkpoint = 'completed', finished_at = now(),
             lease_token = NULL, lease_expires_at = NULL
         WHERE id = $1 AND status = 'running' AND lease_token = $2`,
        [runId, leaseToken],
      );
      if (updated.rowCount !== 1) throw new ImportRunConflictError("Import run lease was lost before completion.");
      await client.query(
        `INSERT INTO compendium_import_audit (import_run_id, event_type, from_status, to_status, actor)
         VALUES ($1, 'completed', 'running', 'succeeded', $2)`,
        [runId, actor.trim()],
      );
    });
  }

  async failRun(runId: string, leaseToken: string, actor: string, message: string): Promise<void> {
    validateLeaseArguments(runId, leaseToken, actor); requireText(message, "message");
    await this.transaction(async (client) => {
      await lockLeasedRun(client, runId, leaseToken);
      const updated = await client.query(
        `UPDATE compendium_import_runs
         SET status = 'failed', finished_at = now(), lease_token = NULL, lease_expires_at = NULL
         WHERE id = $1 AND status = 'running' AND lease_token = $2`,
        [runId, leaseToken],
      );
      if (updated.rowCount !== 1) throw new ImportRunConflictError("Import run lease was lost before failure was recorded.");
      await client.query(
        `INSERT INTO compendium_import_audit (import_run_id, event_type, from_status, to_status, actor, details)
         VALUES ($1, 'failed', 'running', 'failed', $2, $3::jsonb)`,
        [runId, actor.trim(), JSON.stringify({ message: message.trim() })],
      );
    });
  }
}

async function lockLeasedRun(client: DbClient, runId: string, leaseToken: string): Promise<RunRow> {
  const row = (await client.query<RunRow & { lease_active: boolean }>(
    `SELECT id, source_id, file_id, generation_id, status, checkpoint, lease_token, allowed_review_entry_types,
            lease_expires_at > now() AS lease_active
     FROM compendium_import_runs WHERE id = $1 FOR UPDATE`,
    [runId],
  )).rows[0];
  if (!row || row.status !== "running" || row.lease_token !== leaseToken || !row.lease_active) throw new ImportRunConflictError("Import run lease is missing or expired.");
  return row;
}

async function insertCheckpoint(client: DbClient, runId: string, key: string, hash: string, details: Readonly<Record<string, unknown>>): Promise<void> {
  const inserted = await client.query<{ content_sha256: string; details: Record<string, unknown> }>(
    `INSERT INTO compendium_import_checkpoints (import_run_id, checkpoint_key, content_sha256, details)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (import_run_id, checkpoint_key) DO NOTHING
     RETURNING content_sha256, details`,
    [runId, key, hash, canonicalJson(details)],
  );
  if (!inserted.rows[0]) {
    await verifyCheckpoint(client, runId, key, hash, details);
  }
}

async function verifyCheckpoint(client: DbClient, runId: string, key: string, hash: string, details: Readonly<Record<string, unknown>>): Promise<void> {
  const existing = (await client.query<{ content_sha256: string; details: Record<string, unknown> }>(
    "SELECT content_sha256, details FROM compendium_import_checkpoints WHERE import_run_id = $1 AND checkpoint_key = $2",
    [runId, key],
  )).rows[0];
  if (!existing || existing.content_sha256 !== hash || canonicalJson(existing.details) !== canonicalJson(details)) {
    throw new ImportRunConflictError(`Checkpoint ${key} has different immutable content.`);
  }
}

async function refreshCounters(client: DbClient, runId: string, checkpoint: RunRow["checkpoint"]): Promise<void> {
  await client.query(
    `UPDATE compendium_import_runs run SET checkpoint = $2,
       occurrence_count = (SELECT count(*)::integer FROM compendium_import_occurrences WHERE import_run_id = run.id),
       candidate_count = (SELECT count(*)::integer FROM compendium_import_candidates WHERE import_run_id = run.id),
       diagnostic_count = (SELECT count(*)::integer FROM compendium_import_diagnostics WHERE import_run_id = run.id),
       new_count = (SELECT count(*)::integer FROM compendium_import_candidates WHERE import_run_id = run.id AND diff_status = 'new'),
       unchanged_count = (SELECT count(*)::integer FROM compendium_import_candidates WHERE import_run_id = run.id AND diff_status = 'unchanged'),
       changed_count = (SELECT count(*)::integer FROM compendium_import_candidates WHERE import_run_id = run.id AND diff_status = 'changed'),
       missing_count = (SELECT count(*)::integer FROM compendium_import_candidates WHERE import_run_id = run.id AND diff_status = 'missing'),
       duplicate_count = (SELECT count(*)::integer FROM compendium_import_candidates WHERE import_run_id = run.id AND diff_status = 'duplicate'),
       invalid_count = (SELECT count(*)::integer FROM compendium_import_candidates WHERE import_run_id = run.id AND diff_status = 'invalid')
     WHERE run.id = $1`,
    [runId, checkpoint],
  );
}

async function loadCandidateRows(client: DbClient, runId: string): Promise<readonly CandidateRow[]> {
  return (await client.query<CandidateRow>(
    `SELECT id, import_run_id, source_id, file_id, generation_id, occurrence_id,
            previous_candidate_id, candidate_order, candidate_key, entry_type, diff_status,
            content, content_sha256, invalid_reason, created_at
     FROM compendium_import_candidates WHERE import_run_id = $1 ORDER BY candidate_order, id`,
    [runId],
  )).rows;
}

function candidatesFromRows(rows: readonly CandidateRow[]): readonly ImportCandidate[] {
  return rows.map((row) => ({ id: row.id, candidateKey: row.candidate_key, diffStatus: row.diff_status, contentSha256: row.content_sha256 }));
}

async function audit(client: DbClient, runId: string, event: string, actor: string, details: Readonly<Record<string, unknown>>): Promise<void> {
  await client.query(
    "INSERT INTO compendium_import_audit (import_run_id, event_type, actor, details) VALUES ($1,$2,$3,$4::jsonb)",
    [runId, event, actor.trim(), canonicalJson(details)],
  );
}

function validateRunInput(input: CreateImportRunInput): void {
  if (input.id != null) requireUuid(input.id, "id");
  requireUuid(input.sourceId, "sourceId"); requireUuid(input.fileId, "fileId");
  if (input.generationId != null) requireUuid(input.generationId, "generationId");
  if (input.ingestionJobId != null) requireUuid(input.ingestionJobId, "ingestionJobId");
  for (const [field, value] of [["importer", input.importer], ["importerVersion", input.importerVersion], ["parserVersion", input.parserVersion], ["promptVersion", input.promptVersion], ["modelVersion", input.modelVersion], ["actor", input.actor]] as const) requireText(value, field);
  requireHash(input.inputSha256, "inputSha256");
  if (input.allowedReviewEntryTypes !== undefined && input.allowedReviewEntryTypes !== null) {
    if (!Array.isArray(input.allowedReviewEntryTypes) || input.allowedReviewEntryTypes.length === 0
      || new Set(input.allowedReviewEntryTypes).size !== input.allowedReviewEntryTypes.length
      || input.allowedReviewEntryTypes.some((entryType) => !IMPORT_CANDIDATE_ENTRY_TYPES.includes(entryType))) {
      throw new CompendiumValidationError("allowedReviewEntryTypes must contain unique supported candidate entry types.");
    }
  }
  const hasReviewScope = input.allowedReviewEntryTypes !== undefined && input.allowedReviewEntryTypes !== null;
  if ((input.importer.trim() === "approved-2024-corpus-seed") !== hasReviewScope) {
    throw new CompendiumValidationError("Only approved corpus seed runs require an explicit allowed review entry-type scope.");
  }
}

function validateLeaseArguments(runId: string, leaseToken: string, actor: string): void {
  requireUuid(runId, "runId"); requireUuid(leaseToken, "leaseToken"); requireText(actor, "actor");
}

function runFromRow(row: RunRow): ImportRun {
  return { id: row.id, sourceId: row.source_id, fileId: row.file_id, generationId: row.generation_id, status: row.status, checkpoint: row.checkpoint };
}

function sameReviewScope(left: readonly ImportCandidateEntryType[] | null, right: readonly ImportCandidateEntryType[] | null): boolean {
  return left === null ? right === null : right !== null && left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new CompendiumValidationError("Candidate content must be JSON serializable.");
  return encoded;
}

function occurrenceMatches(row: OccurrenceRow, run: RunRow, input: ImportOccurrenceInput): boolean {
  return row.import_run_id === run.id
    && row.source_id === run.source_id
    && row.file_id === run.file_id
    && row.generation_id === run.generation_id
    && row.chunk_id === (input.chunkId ?? null)
    && row.occurrence_index === input.occurrenceIndex
    && row.locator === input.locator.trim()
    && row.fingerprint_sha256 === input.fingerprintSha256
    && (row.raw_blob_path ?? null) === (input.rawBlobPath ?? null)
    && nullableTimestamp(row.source_fetched_at ?? null) === (input.sourceFetchedAt ?? null)
    && (row.index_locator ?? null) === (input.indexLocator ?? null)
    && (row.index_fingerprint_sha256 ?? null) === (input.indexFingerprintSha256 ?? null)
    && (row.raw_index_blob_path ?? null) === (input.rawIndexBlobPath ?? null)
    && nullableTimestamp(row.index_source_fetched_at ?? null) === (input.indexSourceFetchedAt ?? null)
    && (row.index_card_fingerprint_sha256 ?? null) === (input.indexCardFingerprintSha256 ?? null)
    && (row.metadata_evidence_text ?? null) === (input.metadataEvidenceText ?? null);
}

function occurrenceManifest(row: OccurrenceRow): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    importRunId: row.import_run_id,
    sourceId: row.source_id,
    fileId: row.file_id,
    generationId: row.generation_id,
    chunkId: row.chunk_id,
    occurrenceIndex: row.occurrence_index,
    locator: row.locator,
    fingerprintSha256: row.fingerprint_sha256,
    rawBlobPath: row.raw_blob_path,
    sourceFetchedAt: nullableTimestamp(row.source_fetched_at),
    indexLocator: row.index_locator,
    indexFingerprintSha256: row.index_fingerprint_sha256,
    rawIndexBlobPath: row.raw_index_blob_path,
    indexSourceFetchedAt: nullableTimestamp(row.index_source_fetched_at),
    indexCardFingerprintSha256: row.index_card_fingerprint_sha256,
    metadataEvidenceText: row.metadata_evidence_text,
    createdAt: timestamp(row.created_at),
  };
}

function candidateMatches(row: CandidateRow, run: RunRow, candidate: Readonly<{
  candidateOrder: number;
  occurrenceId: string | null;
  previous: BaselineCandidateRow | null;
  key: string;
  type: ImportCandidateEntryType | null;
  status: ImportDiffStatus;
  content: Readonly<Record<string, unknown>>;
  hash: string;
  invalidReason: string | null;
}> | undefined): boolean {
  return candidate !== undefined
    && row.import_run_id === run.id
    && row.source_id === run.source_id
    && row.file_id === run.file_id
    && row.generation_id === run.generation_id
    && row.occurrence_id === candidate.occurrenceId
    && row.previous_candidate_id === (candidate.previous?.id ?? null)
    && row.candidate_order === candidate.candidateOrder
    && row.candidate_key === candidate.key
    && row.entry_type === candidate.type
    && row.diff_status === candidate.status
    && canonicalJson(row.content) === canonicalJson(candidate.content)
    && row.content_sha256 === candidate.hash
    && row.invalid_reason === candidate.invalidReason;
}

function candidateManifest(row: CandidateRow): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    importRunId: row.import_run_id,
    sourceId: row.source_id,
    fileId: row.file_id,
    generationId: row.generation_id,
    occurrenceId: row.occurrence_id,
    previousCandidateId: row.previous_candidate_id,
    candidateOrder: row.candidate_order,
    candidateKey: row.candidate_key,
    entryType: row.entry_type,
    diffStatus: row.diff_status,
    content: row.content,
    contentSha256: row.content_sha256,
    invalidReason: row.invalid_reason,
    createdAt: timestamp(row.created_at),
  };
}

function candidateReplayMatches(
  rows: readonly CandidateRow[],
  run: RunRow,
  inputs: readonly ImportCandidateInput[],
  occurrenceByIndex: ReadonlyMap<number, string>,
): boolean {
  if (rows.length < inputs.length) return false;
  const seen = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    const row = rows[index];
    const key = input.candidateKey?.trim() ?? "";
    const type = input.entryType ?? null;
    const invalidReason = input.invalidReason?.trim()
      || (!validCandidateKey(key) ? "candidateKey must be a stable lowercase key" : null)
      || (!type || !IMPORT_CANDIDATE_ENTRY_TYPES.includes(type) ? "entryType is unsupported" : null);
    const duplicate = !invalidReason && seen.has(key);
    if (!invalidReason) seen.add(key);
    if (!row
      || row.import_run_id !== run.id
      || row.source_id !== run.source_id
      || row.file_id !== run.file_id
      || row.generation_id !== run.generation_id
      || row.occurrence_id !== occurrenceByIndex.get(input.occurrenceIndex)
      || row.candidate_order !== index
      || row.candidate_key !== (key || `invalid:${input.occurrenceIndex}`)
      || row.entry_type !== type
      || canonicalJson(row.content) !== canonicalJson(input.content)
      || row.content_sha256 !== sha256Json(input.content)
      || row.invalid_reason !== invalidReason
      || (invalidReason ? row.diff_status !== "invalid" || row.previous_candidate_id !== null : false)
      || (duplicate ? row.diff_status !== "duplicate" || row.previous_candidate_id !== null : false)
      || (!invalidReason && !duplicate && !["new", "unchanged", "changed"].includes(row.diff_status))
      || (row.diff_status === "new" && row.previous_candidate_id !== null)
      || (["unchanged", "changed"].includes(row.diff_status) && row.previous_candidate_id === null)) return false;
  }
  return rows.slice(inputs.length).every((row, offset) => row.import_run_id === run.id
    && row.source_id === run.source_id
    && row.file_id === run.file_id
    && row.generation_id === run.generation_id
    && row.occurrence_id === null
    && row.previous_candidate_id !== null
    && row.candidate_order === inputs.length + offset
    && row.entry_type !== null
    && row.diff_status === "missing"
    && row.invalid_reason === null);
}

function timestamp(value: string | Date): string { return value instanceof Date ? value.toISOString() : value; }
function nullableTimestamp(value: string | Date | null): string | null { return value === null ? null : timestamp(value); }
function validateRawOccurrenceEvidence(input: ImportOccurrenceInput): void {
  const path = input.rawBlobPath ?? null;
  const fetchedAt = input.sourceFetchedAt ?? null;
  if ((path === null) !== (fetchedAt === null)) throw new CompendiumValidationError("rawBlobPath and sourceFetchedAt must be supplied together.");
  if (path !== null && !validRawEvidencePath(path, input.fingerprintSha256)) throw new CompendiumValidationError("rawBlobPath must match the occurrence fingerprint in cache or canonical evidence.");
  if (fetchedAt !== null && (!Number.isFinite(Date.parse(fetchedAt)) || new Date(fetchedAt).toISOString() !== fetchedAt)) {
    throw new CompendiumValidationError("sourceFetchedAt must be a canonical date-time.");
  }
  const indexValues = [input.indexLocator, input.indexFingerprintSha256, input.rawIndexBlobPath,
    input.indexSourceFetchedAt, input.indexCardFingerprintSha256, input.metadataEvidenceText].map((value) => value ?? null);
  if (indexValues.some((value) => value !== null) && indexValues.some((value) => value === null)) {
    throw new CompendiumValidationError("Index occurrence evidence must be supplied as one complete immutable envelope.");
  }
  if (input.indexFingerprintSha256 != null) {
    requireHash(input.indexFingerprintSha256, "indexFingerprintSha256");
    requireHash(input.indexCardFingerprintSha256!, "indexCardFingerprintSha256");
    requireText(input.indexLocator!, "indexLocator");
    requireText(input.metadataEvidenceText!, "metadataEvidenceText");
    if (!validRawEvidencePath(input.rawIndexBlobPath!, input.indexFingerprintSha256)) {
      throw new CompendiumValidationError("rawIndexBlobPath must match the index fingerprint.");
    }
    if (!Number.isFinite(Date.parse(input.indexSourceFetchedAt!)) || new Date(input.indexSourceFetchedAt!).toISOString() !== input.indexSourceFetchedAt) {
      throw new CompendiumValidationError("indexSourceFetchedAt must be a canonical date-time.");
    }
  }
}
function validRawEvidencePath(path: string, hash: string): boolean { return path === `blobs/${hash}.html`; }

function sha256Json(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function candidateIdentity(type: ImportCandidateEntryType, key: string): string { return `${type}:${key}`; }
function validCandidateKey(value: string): boolean { return /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value); }
function requireHash(value: string, field: string): void { if (!/^[0-9a-f]{64}$/.test(value)) throw new CompendiumValidationError(`${field} must be a lowercase SHA-256 hash.`); }
function requireUuid(value: string, field: string): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new CompendiumValidationError(`${field} must be a UUID.`); }
function requireText(value: string, field: string): void { if (typeof value !== "string" || !value.trim()) throw new CompendiumValidationError(`${field} is required.`); }
function requireObject(value: unknown, field: string): asserts value is Readonly<Record<string, unknown>> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompendiumValidationError(`${field} must be an object.`); canonicalJson(value); }
function requiredRow<T>(row: T | undefined, message: string): T { if (!row) throw new CompendiumValidationError(message); return row; }
