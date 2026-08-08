import type { QueryResultRow } from "pg";

import { withTransaction } from "../db/client.ts";
import { CompendiumImportRunService } from "../compendium/import-runs.ts";
import { loadResolvedRepositoryManifest } from "../content-storage/validation.ts";
import { installSeedSource, verifySeedSource } from "./source-installer.ts";
import { seedImportBatch } from "./batch.ts";
import { canonicalJson, type PreparedSeed, type PreparedSeedSlot } from "./model.ts";

export type SeedTypeCounts = Readonly<{ discovered: number; imported: number; reviewed: number; published: number; indexed: number; failures: number }>;
export type SeedSlotResult = Readonly<{
  slotId: string;
  contentType: string;
  sourceId: string | null;
  importRunId: string | null;
  operation: "loaded" | "resumed" | "noop" | "absent" | "pending" | "failed";
  counts: SeedTypeCounts;
  failures: readonly string[];
  provenance: Readonly<{ canonicalSourceId: string; originUrl: string; originId: string; attribution: string; license: string; evidenceReference: string }>;
}>;

type Db = Readonly<{ query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount?: number | null }> }>;
type Transaction = <T>(callback: (client: Db) => Promise<T>) => Promise<T>;
type RunService = Pick<CompendiumImportRunService, "createRun" | "claimRun" | "recordOccurrences" | "computeCandidateDiff" | "addDiagnostic" | "completeRun" | "failRun">;
export type SeedExecutionDependencies = Readonly<{
  transaction?: Transaction;
  db?: Db;
  runs?: RunService;
  dataRoot?: string;
  sourceInstaller?: (slot: PreparedSeedSlot, fileId: string, dataRoot: string) => Promise<void>;
  afterImport?: (slot: PreparedSeedSlot) => Promise<void>;
}>;

export async function loadPreparedSeed(prepared: PreparedSeed, dependencies: SeedExecutionDependencies = {}): Promise<readonly SeedSlotResult[]> {
  const transaction = dependencies.transaction ?? withTransaction as Transaction;
  const db = dependencies.db ?? { query: async (sql: string, values?: readonly unknown[]) => (await import("../db/client.ts")).query(sql, values) };
  const runs = dependencies.runs ?? new CompendiumImportRunService();
  const sourceInstaller = dependencies.sourceInstaller ?? installSeedSource;
  if (!dependencies.dataRoot && !dependencies.sourceInstaller) throw new Error("Corpus seed load requires worker-owned DND_DATA_ROOT.");
  const results: SeedSlotResult[] = [];
  for (const slot of prepared.slots) {
    let sourceId: string | null = null;
    let runId: string | null = null;
    let leaseToken: string | null = null;
    let operation: SeedSlotResult["operation"] = "loaded";
    try {
      const blocked = slot.planSlot.dependsOn.find((dependency) => !results.some((result) => result.slotId === dependency && result.operation !== "failed"));
      if (blocked) throw new Error(`Required dependency ${blocked} did not load successfully.`);
      const boundary = await ensureSourceBoundary(slot, transaction, sourceInstaller, dependencies.dataRoot ?? "test-injected");
      sourceId = boundary.sourceId;
      const run = await runs.createRun({
        sourceId: boundary.sourceId,
        fileId: boundary.fileId,
        importer: "approved-2024-corpus-seed",
        importerVersion: String(prepared.plan.schemaVersion),
        parserVersion: slot.manifest.parserVersion,
        promptVersion: "none",
        modelVersion: "none",
        inputSha256: slot.inputDigest,
        actor: "corpus-seed-cli",
      });
      runId = run.id;
      const claim = await runs.claimRun(run.id, "corpus-seed-cli");
      if (claim.completed) {
        operation = "noop";
      } else {
        leaseToken = claim.leaseToken;
        if (!leaseToken) throw new Error("Claimed seed import run did not return a lease token.");
        operation = run.status === "failed" || run.checkpoint !== "created" ? "resumed" : "loaded";
        const batch = seedImportBatch(slot);
        await runs.recordOccurrences(run.id, leaseToken, batch.occurrences, "corpus-seed-cli");
        await runs.computeCandidateDiff(run.id, leaseToken, batch.candidates, "corpus-seed-cli");
        await dependencies.afterImport?.(slot);
        await runs.completeRun(run.id, leaseToken, "corpus-seed-cli");
        leaseToken = null;
      }
      results.push(await resultFromState(slot, db, sourceId, runId, operation, [], dependencies.dataRoot));
    } catch (error) {
      const message = safeError(error);
      if (runId && leaseToken) await runs.failRun(runId, leaseToken, "corpus-seed-cli", message).catch(() => undefined);
      results.push(await resultFromState(slot, db, sourceId, runId, "failed", [message]).catch(() => baseResult(slot, sourceId, runId, "failed", [message])));
    }
  }
  return results;
}

export async function inspectPreparedSeed(prepared: PreparedSeed, db: Db, dataRoot: string, verifier = verifySeedSource): Promise<readonly SeedSlotResult[]> {
  const results: SeedSlotResult[] = [];
  for (const slot of prepared.slots) {
    const row = (await db.query<{ source_id: string; file_id: string; run_id: string; run_status: string }>(
      `SELECT source.id AS source_id, file.id AS file_id, run.id AS run_id, run.status::text AS run_status
       FROM sources source
       JOIN files file ON file.source_id = source.id AND file.checksum_sha256 = $2 AND file.deleted_at IS NULL
       JOIN compendium_import_runs run ON run.source_id = source.id AND run.file_id = file.id
         AND run.importer = 'approved-2024-corpus-seed' AND run.input_sha256 = $3
       WHERE source.canonical_source_id = $1 AND source.deleted_at IS NULL
       ORDER BY run.created_at DESC LIMIT 1`,
      [slot.input.source.canonicalSourceId, slot.manifestDigest, slot.inputDigest],
    )).rows[0];
    let operation: SeedSlotResult["operation"] = row?.run_status === "succeeded" ? "noop" : row?.run_status === "failed" ? "failed" : row ? "pending" : "absent";
    const failures: string[] = row?.run_status === "failed" ? ["Durable import run is failed and remains retryable."] : [];
    if (row) try { await verifier(slot, row.file_id, dataRoot); } catch (error) { operation = "failed"; failures.push(safeError(error)); }
    results.push(row ? await resultFromState(slot, db, row.source_id, row.run_id, operation, failures, dataRoot) : baseResult(slot, null, null, "absent", ["Required seed slot has no durable import run."]));
  }
  return results;
}

async function ensureSourceBoundary(slot: PreparedSeedSlot, transaction: Transaction, installer: NonNullable<SeedExecutionDependencies["sourceInstaller"]>, dataRoot: string): Promise<{ sourceId: string; fileId: string }> {
  return transaction(async (client) => {
    const source = slot.input.source;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`corpus-seed:${source.canonicalSourceId}`]);
    await client.query(
      `INSERT INTO sources (
         canonical_source_id,title,category,edition,language,access_tier,shared,publication_code,
         publication_title,publisher,release_year,publication_revision,external_origin_url,
         external_origin_id,attribution,source_priority,canonical_book_id,license,metadata)
       VALUES ($1,$2,$3,'5.5e',$4,$5,$6,$7,$2,$8,2024,$9,$10,$11,$12,0,$13,$14,$15::jsonb)
       ON CONFLICT (canonical_source_id) WHERE canonical_source_id IS NOT NULL DO NOTHING`,
      [source.canonicalSourceId, source.title, source.category, source.language, source.accessTier, source.accessTier === "premium",
        source.publicationCode, source.publisher, source.revision, source.originUrl, source.originId, source.attribution,
        source.canonicalBookId, source.license, JSON.stringify({ corpusSeed: { inputSlotId: slot.planSlot.inputSlotId, licenseApproval: source.licenseApproval } })],
    );
    const persisted = (await client.query<{
      id: string; title: string; category: string; edition: string; language: string; access_tier: string; publication_code: string;
      publisher: string; release_year: number; publication_revision: string; external_origin_url: string; external_origin_id: string;
      attribution: string; canonical_book_id: string; license: string; metadata: Record<string, unknown>;
    }>(`SELECT id,title,category,edition,language,access_tier,publication_code,publisher,release_year,publication_revision,
              external_origin_url,external_origin_id,attribution,canonical_book_id,license,metadata
         FROM sources WHERE canonical_source_id=$1 AND deleted_at IS NULL FOR UPDATE`, [source.canonicalSourceId])).rows[0];
    if (!persisted || persisted.title !== source.title || persisted.category !== source.category || persisted.edition !== "5.5e"
      || persisted.language !== source.language || persisted.access_tier !== source.accessTier || persisted.publication_code !== source.publicationCode
      || persisted.publisher !== source.publisher || persisted.release_year !== 2024 || persisted.publication_revision !== source.revision
      || persisted.external_origin_url !== source.originUrl || persisted.external_origin_id !== source.originId || persisted.attribution !== source.attribution
      || persisted.canonical_book_id !== source.canonicalBookId || persisted.license !== source.license
      || canonicalJson(persisted.metadata?.corpusSeed ?? null) !== canonicalJson({ inputSlotId: slot.planSlot.inputSlotId, licenseApproval: source.licenseApproval })) {
      throw new Error(`Canonical source ${source.canonicalSourceId} already exists with different approved provenance or access metadata.`);
    }
    const insertedFile = (await client.query<{ id: string }>(
      `INSERT INTO files (source_id,original_filename,mime_type,checksum_sha256,byte_size,storage_path)
       VALUES ($1,$2,'application/vnd.dnd-firegory.snapshot+json',$3,$4,$5)
       ON CONFLICT (source_id,checksum_sha256) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id`,
      [persisted.id, `${slot.planSlot.inputSlotId}-snapshot-manifest.json`, slot.manifestDigest, slot.manifestByteLength, `canonical-seed:sha256:${slot.manifestDigest}`],
    )).rows[0];
    const file = insertedFile ?? (await client.query<{ id: string; byte_size: string; mime_type: string }>(
      `SELECT id,byte_size,mime_type FROM files WHERE source_id=$1 AND checksum_sha256=$2 AND deleted_at IS NULL FOR SHARE`,
      [persisted.id, slot.manifestDigest],
    )).rows[0];
    if (file && (Number("byte_size" in file ? file.byte_size : slot.manifestByteLength) !== slot.manifestByteLength
      || ("mime_type" in file && file.mime_type !== "application/vnd.dnd-firegory.snapshot+json"))) throw new Error(`Seed file boundary for slot ${slot.planSlot.id} conflicts with durable metadata.`);
    if (!file) throw new Error(`Unable to establish seed file boundary for slot ${slot.planSlot.id}.`);
    await installer(slot, file.id, dataRoot);
    return { sourceId: persisted.id, fileId: file.id };
  });
}

async function resultFromState(slot: PreparedSeedSlot, db: Db, sourceId: string | null, runId: string | null, operation: SeedSlotResult["operation"], failures: readonly string[], dataRoot?: string): Promise<SeedSlotResult> {
  if (!runId) return baseResult(slot, sourceId, runId, operation, failures);
  if (!dataRoot || !sourceId) {
    const imported = Number((await db.query<{ imported: number }>(
      `SELECT count(*)::integer AS imported FROM compendium_import_candidates WHERE import_run_id=$1 AND entry_type::text=$2`,
      [runId, slot.planSlot.contentType],
    )).rows[0]?.imported ?? 0);
    return { ...baseResult(slot, sourceId, runId, operation, failures), counts: { discovered: slot.discovered, imported, reviewed: 0, published: 0, indexed: 0, failures: failures.length } };
  }
  const { manifest, generation } = await loadResolvedRepositoryManifest(dataRoot);
  const active = manifest.entries.map(({ entryId, revisionId }) => ({ entryId, revisionId }));
  const row = (await db.query<{ imported: number; reviewed: number; published: number; indexed: number }>(
    `WITH active AS (SELECT * FROM jsonb_to_recordset($6::jsonb) AS item("entryId" text, "revisionId" text))
      SELECT count(DISTINCT candidate.id)::integer AS imported,
             count(DISTINCT candidate.id) FILTER (WHERE review.decision IS NOT NULL AND review.decision <> 'pending')::integer AS reviewed,
             count(DISTINCT candidate.id) FILTER (WHERE review.publication_status = 'completed' AND active."revisionId" = review.canonical_revision_id)::integer AS published,
             count(DISTINCT candidate.id) FILTER (WHERE indexed.entry_id IS NOT NULL)::integer AS indexed
       FROM compendium_import_candidates candidate
       LEFT JOIN compendium_import_candidate_reviews review ON review.candidate_id = candidate.id
       LEFT JOIN active ON active."entryId" = candidate.entry_type::text || '-' || candidate.candidate_key
       LEFT JOIN nfs_index_entries indexed ON indexed.repository_id=$3 AND indexed.entry_id=active."entryId"
         AND indexed.revision_id=active."revisionId" AND indexed.source_id=$4 AND indexed.file_id=candidate.file_id AND indexed.lifecycle='active'
         AND (SELECT sync.repository_generation FROM nfs_index_sync_runs sync WHERE sync.repository_id=$3 AND sync.status='succeeded' ORDER BY sync.finished_at DESC, sync.id DESC LIMIT 1) IS NOT DISTINCT FROM $5
       WHERE candidate.import_run_id=$1 AND candidate.entry_type::text=$2`,
    [runId, slot.planSlot.contentType, manifest.repositoryId, sourceId, generation, JSON.stringify(active)],
  )).rows[0];
  return { ...baseResult(slot, sourceId, runId, operation, failures), counts: { discovered: slot.discovered, imported: Number(row?.imported ?? 0), reviewed: Number(row?.reviewed ?? 0), published: Number(row?.published ?? 0), indexed: Number(row?.indexed ?? 0), failures: failures.length } };
}

function baseResult(slot: PreparedSeedSlot, sourceId: string | null, importRunId: string | null, operation: SeedSlotResult["operation"], failures: readonly string[]): SeedSlotResult {
  const source = slot.input.source;
  return {
    slotId: slot.planSlot.id, contentType: slot.planSlot.contentType, sourceId, importRunId, operation,
    counts: { discovered: slot.discovered, imported: 0, reviewed: 0, published: 0, indexed: 0, failures: failures.length }, failures,
    provenance: { canonicalSourceId: source.canonicalSourceId, originUrl: source.originUrl, originId: source.originId, attribution: source.attribution, license: source.license, evidenceReference: source.licenseApproval.evidenceUri },
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[REDACTED_DATABASE_URL]").replace(/(password|secret|token)=\S+/giu, "$1=[REDACTED]").replace(/(^|[\s"'])\/(?:[^\s"']+)/gu, "$1[REDACTED_PATH]").slice(0, 2000);
}
