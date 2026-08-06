import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { query, withTransaction } from "../db/client.ts";
import { getDataRoot } from "../content-storage/repository.ts";
import { loadResolvedCanonicalRevisions } from "../content-storage/validation.ts";
import {
  deterministicUuid,
  projectCanonicalRevisions,
  projectionHash,
  sourceFilename,
  type IndexedEntryProjection,
} from "./projection.ts";

type Queryable = Readonly<{
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}>;

export type SyncMode = "clean" | "incremental";
export type SyncPlan = Readonly<{
  additions: readonly string[];
  updates: readonly string[];
  removals: readonly string[];
}>;
export type SyncResult = Readonly<{
  mode: SyncMode | "validate";
  repositoryId: string;
  manifestHash: string;
  generation: string | null;
  plan: SyncPlan;
  dryRun: boolean;
  resumed: boolean;
  runId: string | null;
}>;

type ActiveRow = { entry_id: string; revision_id: string; content_hash: string; file_id: string };

export type SyncDependencies = Readonly<{
  execute?: typeof query;
  transaction?: typeof withTransaction;
  afterCheckpoint?: (entryId: string, stagedEntries: number) => void | Promise<void>;
}>;

export async function synchronizeContentIndex(input: Readonly<{
  mode: SyncMode | "validate";
  dryRun?: boolean;
  dataRoot?: string;
}>, dependencies: SyncDependencies = {}): Promise<SyncResult> {
  const dataRoot = input.dataRoot ?? getDataRoot();
  // This resolves deltas and validates every schema, revision hash, source record,
  // and source-file hash before the first database query or mutation.
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const repositoryId = resolved.manifest.repositoryId;
  const projections = projectCanonicalRevisions(repositoryId, resolved.revisions);
  const manifestHash = projectionHash(repositoryId, resolved.revisions);
  const emptyPlan: SyncPlan = { additions: [], updates: [], removals: [] };

  if (input.mode === "validate") {
    return { mode: "validate", repositoryId, manifestHash, generation: resolved.generation, plan: emptyPlan, dryRun: true, resumed: false, runId: null };
  }

  const execute = dependencies.execute ?? query;
  const activeResult = await execute<ActiveRow>(
    `SELECT entry_id, revision_id, content_hash, file_id
     FROM nfs_index_entries
     WHERE repository_id = $1 AND lifecycle = 'active'
     ORDER BY entry_id`,
    [repositoryId],
  );
  const plan = buildSyncPlan(input.mode, projections, activeResult.rows);
  const hasChanges = plan.additions.length + plan.updates.length + plan.removals.length > 0;
  if (input.dryRun || !hasChanges) {
    return { mode: input.mode, repositoryId, manifestHash, generation: resolved.generation, plan, dryRun: Boolean(input.dryRun), resumed: false, runId: null };
  }

  const run = await findOrCreateRun(execute, {
    repositoryId,
    manifestHash,
    generation: resolved.generation,
    mode: input.mode,
    plan,
  });
  const staged = await execute<{ entry_id: string }>(
    "SELECT entry_id FROM nfs_index_sync_staging WHERE run_id = $1",
    [run.id],
  );
  const alreadyStaged = new Set(staged.rows.map((row) => row.entry_id));
  let stagedEntries = alreadyStaged.size;
  await execute(
    "UPDATE nfs_index_sync_runs SET status = 'staging', error_summary = NULL, finished_at = NULL, updated_at = now() WHERE id = $1",
    [run.id],
  );
  for (const [ordinal, projection] of projections.entries()) {
    if (alreadyStaged.has(projection.entryId)) continue;
    await execute(
      `INSERT INTO nfs_index_sync_staging (run_id, entry_id, ordinal, revision_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (run_id, entry_id) DO NOTHING`,
      [run.id, projection.entryId, ordinal, projection.revisionId, JSON.stringify(projection)],
    );
    const checkpoint = await execute<{ count: string }>(
      "SELECT count(*)::text AS count FROM nfs_index_sync_staging WHERE run_id = $1",
      [run.id],
    );
    stagedEntries = Number(checkpoint.rows[0]?.count ?? stagedEntries);
    await execute(
      "UPDATE nfs_index_sync_runs SET staged_entries = $2, status = 'staging', error_summary = NULL, finished_at = NULL, updated_at = now() WHERE id = $1",
      [run.id, stagedEntries],
    );
    await dependencies.afterCheckpoint?.(projection.entryId, stagedEntries);
  }

  try {
    await (dependencies.transaction ?? withTransaction)(async (client) => {
      await applySnapshot(client, dataRoot, repositoryId, run.id, projections, plan, activeResult.rows);
    });
  } catch (error) {
    await execute(
      "UPDATE nfs_index_sync_runs SET status = 'failed', error_summary = $2, finished_at = now(), updated_at = now() WHERE id = $1",
      [run.id, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  }

  return { mode: input.mode, repositoryId, manifestHash, generation: resolved.generation, plan, dryRun: false, resumed: run.resumed, runId: run.id };
}

export function buildSyncPlan(
  mode: SyncMode,
  desired: readonly Pick<IndexedEntryProjection, "entryId" | "revisionId" | "contentHash">[],
  active: readonly Pick<ActiveRow, "entry_id" | "revision_id" | "content_hash">[],
): SyncPlan {
  const current = new Map(active.map((entry) => [entry.entry_id, entry]));
  const wanted = new Set(desired.map((entry) => entry.entryId));
  const additions: string[] = [];
  const updates: string[] = [];
  for (const entry of desired) {
    const existing = current.get(entry.entryId);
    if (!existing) additions.push(entry.entryId);
    else if (mode === "clean" || existing.revision_id !== entry.revisionId || existing.content_hash !== entry.contentHash) updates.push(entry.entryId);
  }
  const removals = active.filter((entry) => !wanted.has(entry.entry_id)).map((entry) => entry.entry_id);
  return { additions, updates, removals };
}

async function findOrCreateRun(execute: typeof query, input: Readonly<{
  repositoryId: string;
  manifestHash: string;
  generation: string | null;
  mode: SyncMode;
  plan: SyncPlan;
}>): Promise<{ id: string; resumed: boolean }> {
  const existing = await execute<{ id: string }>(
    `SELECT id FROM nfs_index_sync_runs
     WHERE repository_id = $1 AND manifest_hash = $2 AND mode = $3 AND status IN ('staging', 'failed')
     ORDER BY created_at DESC LIMIT 1`,
    [input.repositoryId, input.manifestHash, input.mode],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, resumed: true };
  const id = randomUUID();
  await execute(
    `INSERT INTO nfs_index_sync_runs
       (id, repository_id, mode, manifest_hash, repository_generation, status,
        planned_additions, planned_updates, planned_removals)
     VALUES ($1, $2, $3, $4, $5, 'staging', $6, $7, $8)`,
    [id, input.repositoryId, input.mode, input.manifestHash, input.generation,
      input.plan.additions.length, input.plan.updates.length, input.plan.removals.length],
  );
  return { id, resumed: false };
}

async function applySnapshot(
  client: PoolClient,
  dataRoot: string,
  repositoryId: string,
  runId: string,
  projections: readonly IndexedEntryProjection[],
  plan: SyncPlan,
  active: readonly ActiveRow[],
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`nfs-index:${repositoryId}`]);
  const lockedActive = await client.query<ActiveRow>(
    `SELECT entry_id, revision_id, content_hash, file_id
     FROM nfs_index_entries
     WHERE repository_id = $1 AND lifecycle = 'active'
     ORDER BY entry_id FOR UPDATE`,
    [repositoryId],
  );
  if (JSON.stringify(lockedActive.rows) !== JSON.stringify(active)) {
    throw new Error("Active NFS index changed while this snapshot was staged; restart synchronization");
  }
  const staged = await client.query<{ payload: IndexedEntryProjection }>(
    "SELECT payload FROM nfs_index_sync_staging WHERE run_id = $1 ORDER BY ordinal FOR UPDATE",
    [runId],
  );
  if (
    staged.rows.length !== projections.length
    || staged.rows.some((row, index) =>
      row.payload.entryId !== projections[index].entryId
      || row.payload.revisionId !== projections[index].revisionId
      || row.payload.contentHash !== projections[index].contentHash
    )
  ) {
    throw new Error("Persisted NFS index staging checkpoint does not match the validated canonical snapshot");
  }
  const stagedProjections = staged.rows.map((row) => row.payload);
  await client.query("UPDATE nfs_index_sync_runs SET status = 'applying', updated_at = now() WHERE id = $1", [runId]);

  const desiredByFile = Map.groupBy(stagedProjections, (entry) => entry.fileUuid);
  const changedEntries = new Set([...plan.additions, ...plan.updates, ...plan.removals]);
  const affectedFiles = new Set(active.filter((entry) => changedEntries.has(entry.entry_id)).map((entry) => entry.file_id));
  for (const entry of stagedProjections) if (changedEntries.has(entry.entryId)) affectedFiles.add(entry.fileUuid);

  for (const entries of desiredByFile.values()) {
    if (!affectedFiles.has(entries[0].fileUuid)) continue;
    await upsertManagedSourceAndFile(client, dataRoot, repositoryId, entries[0]);
    await activateManagedGeneration(client, entries[0]);
    await upsertFileIndexRows(client, repositoryId, entries);
  }

  if (plan.removals.length > 0) {
    await client.query(
      `UPDATE nfs_index_entries SET lifecycle = 'retired', retired_at = now()
       WHERE repository_id = $1 AND entry_id = ANY($2::text[]) AND lifecycle = 'active'`,
      [repositoryId, plan.removals],
    );
  }
  for (const fileId of affectedFiles) {
    if (desiredByFile.has(fileId)) continue;
    await client.query(
      `UPDATE ingestion_generations SET status = 'archived', archived_at = now()
       WHERE id = (SELECT active_generation_id FROM files WHERE id = $1) AND status = 'active'`,
      [fileId],
    );
    await client.query("UPDATE files SET active_generation_id = NULL, deleted_at = now() WHERE id = $1", [fileId]);
  }
  await client.query(
    `UPDATE sources s SET deleted_at = now()
     WHERE EXISTS (SELECT 1 FROM nfs_index_managed_sources ms WHERE ms.source_id = s.id AND ms.repository_id = $1)
       AND NOT EXISTS (SELECT 1 FROM files f WHERE f.source_id = s.id AND f.deleted_at IS NULL)`,
    [repositoryId],
  );
  await client.query(
    "UPDATE nfs_index_sync_runs SET status = 'succeeded', error_summary = NULL, finished_at = now(), updated_at = now() WHERE id = $1",
    [runId],
  );
}

async function upsertManagedSourceAndFile(
  client: Queryable,
  dataRoot: string,
  repositoryId: string,
  entry: IndexedEntryProjection,
): Promise<void> {
  const source = entry.source;
  const ownership = await client.query<{ source_conflict: boolean; file_conflict: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM sources s WHERE s.id = $1
           AND NOT EXISTS (SELECT 1 FROM nfs_index_managed_sources ms WHERE ms.source_id = s.id AND ms.repository_id = $3)
       ) AS source_conflict,
       EXISTS (
         SELECT 1 FROM files f WHERE f.id = $2
           AND NOT EXISTS (SELECT 1 FROM nfs_index_managed_files mf WHERE mf.file_id = f.id AND mf.repository_id = $3)
       ) AS file_conflict`,
    [entry.sourceUuid, entry.fileUuid, repositoryId],
  );
  if (ownership.rows[0]?.source_conflict || ownership.rows[0]?.file_conflict) {
    throw new Error(`Deterministic NFS identity for ${entry.entryId} conflicts with unmanaged content`);
  }
  await client.query(
    `INSERT INTO sources
       (id, title, category, edition, language, access_tier, shared, owner_user_id, metadata,
        canonical_source_id, publication_code, publication_title, publisher, release_year,
        publication_revision, external_origin_url, external_origin_id, attribution, source_priority,
        canonical_book_id, license, deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NULL)
     ON CONFLICT (id) DO UPDATE SET
       title=EXCLUDED.title, category=EXCLUDED.category, edition=EXCLUDED.edition,
       language=EXCLUDED.language, access_tier=EXCLUDED.access_tier, shared=EXCLUDED.shared,
       owner_user_id=EXCLUDED.owner_user_id, metadata=EXCLUDED.metadata,
       publication_code=EXCLUDED.publication_code, publication_title=EXCLUDED.publication_title,
       publisher=EXCLUDED.publisher, release_year=EXCLUDED.release_year,
       publication_revision=EXCLUDED.publication_revision, external_origin_url=EXCLUDED.external_origin_url,
       external_origin_id=EXCLUDED.external_origin_id, attribution=EXCLUDED.attribution,
       source_priority=EXCLUDED.source_priority, canonical_book_id=EXCLUDED.canonical_book_id,
       license=EXCLUDED.license, deleted_at=NULL, updated_at=now()`,
    [entry.sourceUuid, source.title, source.category, source.edition, source.language, source.accessTier,
      source.shared, source.ownerUserId, JSON.stringify({ managedBy: "nfs-content-index", repositoryId }),
      source.sourceId, source.publication.code, source.publication.title, source.publication.publisher,
      source.publication.releaseYear, source.publication.revision ?? null, source.publication.origin?.url ?? null,
      source.publication.origin?.id ?? null, source.publication.attribution ?? null,
      source.publication.sourcePriority, source.publication.canonicalBookId, source.license ?? null],
  );
  await client.query(
    `INSERT INTO nfs_index_managed_sources (source_id, repository_id, canonical_source_id)
     VALUES ($1,$2,$3) ON CONFLICT (source_id) DO NOTHING`,
    [entry.sourceUuid, repositoryId, source.sourceId],
  );
  const filePath = resolve(dataRoot, entry.file.path);
  const size = (await stat(filePath)).size;
  await client.query(
    `INSERT INTO files
       (id, source_id, original_filename, mime_type, checksum_sha256, byte_size, storage_path, deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)
     ON CONFLICT (id) DO UPDATE SET original_filename=EXCLUDED.original_filename,
       mime_type=EXCLUDED.mime_type, checksum_sha256=EXCLUDED.checksum_sha256,
       byte_size=EXCLUDED.byte_size, storage_path=EXCLUDED.storage_path, deleted_at=NULL`,
    [entry.fileUuid, entry.sourceUuid, sourceFilename(entry.file.path), entry.file.mediaType,
      entry.file.contentHash.slice("sha256:".length), size, entry.file.path],
  );
  await client.query(
    `INSERT INTO nfs_index_managed_files (file_id, source_id, repository_id, canonical_file_id)
     VALUES ($1,$2,$3,$4) ON CONFLICT (file_id) DO NOTHING`,
    [entry.fileUuid, entry.sourceUuid, repositoryId, entry.file.fileId],
  );
}

async function activateManagedGeneration(client: Queryable, entry: IndexedEntryProjection): Promise<void> {
  await client.query(
    `UPDATE ingestion_generations SET status='archived', archived_at=now()
     WHERE file_id=$1 AND status='active' AND id<>$2`,
    [entry.fileUuid, entry.generationId],
  );
  await client.query(
    `INSERT INTO ingestion_generations (id, source_id, file_id, status, activated_at)
     VALUES ($1,$2,$3,'active',now())
     ON CONFLICT (id) DO UPDATE SET status='active', archived_at=NULL`,
    [entry.generationId, entry.sourceUuid, entry.fileUuid],
  );
  await client.query("UPDATE files SET active_generation_id=$2, deleted_at=NULL WHERE id=$1", [entry.fileUuid, entry.generationId]);
}

async function upsertFileIndexRows(
  client: Queryable,
  repositoryId: string,
  entries: readonly IndexedEntryProjection[],
): Promise<void> {
  const first = entries[0];
  const pages = new Map<number, string[]>();
  for (const entry of entries) {
    await client.query(
      `INSERT INTO documents (id, source_id, file_id, generation_id, title, document_type, text, metadata)
       VALUES ($1,$2,$3,$4,$5,'canonical-revision',$6,$7::jsonb)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, text=EXCLUDED.text, metadata=EXCLUDED.metadata`,
      [entry.documentId, entry.sourceUuid, entry.fileUuid, entry.generationId, entry.name, entry.plainText,
        JSON.stringify({ managedBy: "nfs-content-index", repositoryId, entryId: entry.entryId, revisionId: entry.revisionId })],
    );
    for (const page of entry.pages) pages.set(page.pageNumber, [...(pages.get(page.pageNumber) ?? []), page.text]);
  }
  const pageIds = new Map<number, string>();
  for (const [pageNumber, texts] of [...pages].sort(([left], [right]) => left - right)) {
    const pageId = deterministicUuid("nfs-index-page", repositoryId, first.generationId, String(pageNumber));
    pageIds.set(pageNumber, pageId);
    await client.query(
      `INSERT INTO pages (id, source_id, file_id, generation_id, page_number, text, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, metadata=EXCLUDED.metadata`,
      [pageId, first.sourceUuid, first.fileUuid, first.generationId, pageNumber,
        [...new Set(texts)].join("\n\n"), JSON.stringify({ managedBy: "nfs-content-index", repositoryId })],
    );
  }
  for (const entry of entries) {
    for (const chunk of entry.chunks) {
      await client.query(
        `INSERT INTO chunks
           (id, source_id, file_id, document_id, page_id, generation_id, chunk_index, text,
            quote_text, section_heading, page_number, text_span_start, text_span_end, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
         ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, quote_text=EXCLUDED.quote_text,
           section_heading=EXCLUDED.section_heading, page_number=EXCLUDED.page_number,
           text_span_start=EXCLUDED.text_span_start, text_span_end=EXCLUDED.text_span_end,
           metadata=EXCLUDED.metadata`,
        [chunk.id, entry.sourceUuid, entry.fileUuid, entry.documentId,
          chunk.pageNumber === null ? null : pageIds.get(chunk.pageNumber) ?? null,
          entry.generationId, chunk.chunkIndex, chunk.text, chunk.quoteText, chunk.sectionHeading,
          chunk.pageNumber, chunk.textSpanStart, chunk.textSpanEnd, JSON.stringify(chunk.metadata)],
      );
    }
    await client.query(
      `INSERT INTO nfs_index_entries
         (id, repository_id, entry_id, revision_id, content_hash, entry_type, name, aliases,
          typed_fields, plain_text, canonical_payload, source_id, file_id, generation_id, document_id,
          lifecycle, retired_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15,'active',NULL)
       ON CONFLICT (repository_id, entry_id) DO UPDATE SET revision_id=EXCLUDED.revision_id,
         content_hash=EXCLUDED.content_hash, entry_type=EXCLUDED.entry_type, name=EXCLUDED.name,
         aliases=EXCLUDED.aliases, typed_fields=EXCLUDED.typed_fields, plain_text=EXCLUDED.plain_text,
         canonical_payload=EXCLUDED.canonical_payload, source_id=EXCLUDED.source_id,
         file_id=EXCLUDED.file_id, generation_id=EXCLUDED.generation_id,
         document_id=EXCLUDED.document_id, lifecycle='active', retired_at=NULL, indexed_at=now()`,
      [entry.id, repositoryId, entry.entryId, entry.revisionId, entry.contentHash, entry.entryType,
        entry.name, JSON.stringify(entry.aliases), JSON.stringify(entry.typedFields), entry.plainText,
        JSON.stringify(entry.canonicalPayload), entry.sourceUuid, entry.fileUuid, entry.generationId, entry.documentId],
    );
  }
}
