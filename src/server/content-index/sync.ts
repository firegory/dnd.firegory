import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { query, withTransaction } from "../db/client.ts";
import { getDataRoot } from "../content-storage/repository.ts";
import { loadResolvedCanonicalRevisions } from "../content-storage/validation.ts";
import {
  deterministicUuid,
  CONTENT_INDEX_PROJECTOR_VERSION,
  entryProjectionHash,
  projectCanonicalRevisions,
  projectionHash,
  sourceFilename,
  type IndexedEntryProjection,
} from "./projection.ts";

type Queryable = Readonly<{
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}>;

const DEFAULT_SYNC_LEASE_SECONDS = 60;

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

type ActiveRow = {
  entry_id: string;
  revision_id: string;
  content_hash: string;
  file_id: string;
  generation_id?: string;
};
export type NfsManagedBinding = Readonly<{ sourceId: string; fileId: string; ownsSource: boolean; ownsFile: boolean }>;

export type SyncDependencies = Readonly<{
  execute?: typeof query;
  transaction?: typeof withTransaction;
  afterCheckpoint?: (entryId: string, stagedEntries: number) => void | Promise<void>;
  ownerToken?: string;
  leaseSeconds?: number;
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
  const projections = projectCanonicalRevisions(repositoryId, resolved.revisions, resolved.sourceFiles);
  const manifestHash = projectionHash(repositoryId, projections);
  const emptyPlan: SyncPlan = { additions: [], updates: [], removals: [] };

  if (input.mode === "validate") {
    return { mode: "validate", repositoryId, manifestHash, generation: resolved.generation, plan: emptyPlan, dryRun: true, resumed: false, runId: null };
  }

  const execute = dependencies.execute ?? query;
  const ownerToken = dependencies.ownerToken ?? randomUUID();
  const leaseSeconds = dependencies.leaseSeconds ?? DEFAULT_SYNC_LEASE_SECONDS;
  const activeResult = await execute<ActiveRow>(
    `SELECT entry_id, revision_id, content_hash, file_id, generation_id
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

  const run = await claimContentIndexRun(execute, {
    repositoryId,
    manifestHash,
    generation: resolved.generation,
    mode: input.mode,
    plan,
    ownerToken,
    leaseSeconds,
  });
  const staged = await execute<{ entry_id: string; payload_hash: string; projector_version: number }>(
    "SELECT entry_id, payload_hash, projector_version FROM nfs_index_sync_staging WHERE run_id = $1",
    [run.id],
  );
  const projectionByEntry = new Map(projections.map((projection) => [projection.entryId, projection]));
  for (const checkpoint of staged.rows) {
    const projection = projectionByEntry.get(checkpoint.entry_id);
    if (
      !projection
      || checkpoint.projector_version !== CONTENT_INDEX_PROJECTOR_VERSION
      || checkpoint.payload_hash !== entryProjectionHash(projection)
    ) {
      await execute(
        `UPDATE nfs_index_sync_runs SET status = 'failed',
           error_summary = 'Persisted projection checkpoint failed integrity validation',
           finished_at = now(), updated_at = now()
         WHERE id = $1 AND owner_token = $2 AND status = 'staging'`,
        [run.id, ownerToken],
      );
      throw new Error(`Persisted checkpoint for ${checkpoint.entry_id} does not match the freshly validated projection`);
    }
  }
  const alreadyStaged = new Set(staged.rows.map((row) => row.entry_id));
  let stagedEntries = alreadyStaged.size;
  for (const [ordinal, projection] of projections.entries()) {
    if (alreadyStaged.has(projection.entryId)) continue;
    await heartbeatContentIndexRun(execute, run.id, ownerToken, leaseSeconds);
    await execute(
      `INSERT INTO nfs_index_sync_staging
         (run_id, entry_id, ordinal, revision_id, projector_version, payload_hash, payload)
       SELECT $1, $2, $3, $4, $5, $6, $7::jsonb
       WHERE EXISTS (
         SELECT 1 FROM nfs_index_sync_runs
         WHERE id = $1 AND owner_token = $8 AND status = 'staging'
           AND lease_expires_at > clock_timestamp()
       )
       ON CONFLICT (run_id, entry_id) DO NOTHING`,
      [run.id, projection.entryId, ordinal, projection.revisionId, CONTENT_INDEX_PROJECTOR_VERSION,
        entryProjectionHash(projection), JSON.stringify(projection), ownerToken],
    );
    const checkpoint = await execute<{ count: string }>(
      "SELECT count(*)::text AS count FROM nfs_index_sync_staging WHERE run_id = $1",
      [run.id],
    );
    stagedEntries = Number(checkpoint.rows[0]?.count ?? stagedEntries);
    await execute(
      `UPDATE nfs_index_sync_runs SET staged_entries = $2, updated_at = now()
       WHERE id = $1 AND owner_token = $3 AND status = 'staging'`,
      [run.id, stagedEntries, ownerToken],
    );
    await dependencies.afterCheckpoint?.(projection.entryId, stagedEntries);
  }

  try {
    await heartbeatContentIndexRun(execute, run.id, ownerToken, leaseSeconds);
    await (dependencies.transaction ?? withTransaction)(async (client) => {
      await applySnapshot(client, repositoryId, run.id, ownerToken, leaseSeconds, projections, plan, activeResult.rows);
    });
  } catch (error) {
    await execute(
      `UPDATE nfs_index_sync_runs SET status = 'failed', error_summary = $2, finished_at = now(), updated_at = now()
       WHERE id = $1 AND owner_token = $3 AND status IN ('staging', 'applying')`,
      [run.id, error instanceof Error ? error.message : String(error), ownerToken],
    );
    throw error;
  }

  return { mode: input.mode, repositoryId, manifestHash, generation: resolved.generation, plan, dryRun: false, resumed: run.resumed, runId: run.id };
}

export function buildSyncPlan(
  mode: SyncMode,
  desired: readonly (Pick<IndexedEntryProjection, "entryId" | "revisionId" | "contentHash">
    & Partial<Pick<IndexedEntryProjection, "generationId">>)[],
  active: readonly Pick<ActiveRow, "entry_id" | "revision_id" | "content_hash" | "generation_id">[],
): SyncPlan {
  const current = new Map(active.map((entry) => [entry.entry_id, entry]));
  const wanted = new Set(desired.map((entry) => entry.entryId));
  const additions: string[] = [];
  const updates: string[] = [];
  for (const entry of desired) {
    const existing = current.get(entry.entryId);
    if (!existing) additions.push(entry.entryId);
    else if (
      mode === "clean"
      || existing.revision_id !== entry.revisionId
      || existing.content_hash !== entry.contentHash
      || (entry.generationId !== undefined && existing.generation_id !== entry.generationId)
    ) updates.push(entry.entryId);
  }
  const removals = active.filter((entry) => !wanted.has(entry.entry_id)).map((entry) => entry.entry_id);
  return { additions, updates, removals };
}

export async function claimContentIndexRun(execute: typeof query, input: Readonly<{
  repositoryId: string;
  manifestHash: string;
  generation: string | null;
  mode: SyncMode;
  plan: SyncPlan;
  ownerToken: string;
  leaseSeconds: number;
}>): Promise<{ id: string; resumed: boolean }> {
  const id = randomUUID();
  const claimed = await execute<{ run_id: string; resumed: boolean }>(
    `SELECT run_id, resumed FROM claim_nfs_index_sync_run(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
     )`,
    [id, input.repositoryId, input.mode, input.manifestHash, CONTENT_INDEX_PROJECTOR_VERSION,
      input.generation, input.plan.additions.length, input.plan.updates.length, input.plan.removals.length,
      input.ownerToken, input.leaseSeconds],
  );
  const row = claimed.rows[0];
  if (!row) throw new Error(`Could not atomically claim NFS index synchronization for ${input.repositoryId}`);
  return { id: row.run_id, resumed: row.resumed };
}

export async function heartbeatContentIndexRun(
  execute: typeof query,
  runId: string,
  ownerToken: string,
  leaseSeconds = DEFAULT_SYNC_LEASE_SECONDS,
): Promise<void> {
  const renewed = await execute<{ id: string }>(
    `UPDATE nfs_index_sync_runs
     SET heartbeat_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => $3),
         updated_at = clock_timestamp()
     WHERE id = $1 AND owner_token = $2 AND status IN ('staging', 'applying')
       AND lease_expires_at > clock_timestamp()
     RETURNING id`,
    [runId, ownerToken, leaseSeconds],
  );
  if (!renewed.rows[0]) throw new Error(`NFS index sync lease for run ${runId} is not owned or has expired`);
}

async function applySnapshot(
  client: PoolClient,
  repositoryId: string,
  runId: string,
  ownerToken: string,
  leaseSeconds: number,
  projections: readonly IndexedEntryProjection[],
  plan: SyncPlan,
  active: readonly ActiveRow[],
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`nfs-index:${repositoryId}`]);
  const run = await client.query<{
    status: "staging" | "applying" | "succeeded" | "failed";
    owner_token: string | null;
    lease_live: boolean;
  }>(
    `SELECT status, owner_token, lease_expires_at > clock_timestamp() AS lease_live
     FROM nfs_index_sync_runs WHERE id = $1 FOR UPDATE`,
    [runId],
  );
  if (run.rows[0]?.status === "succeeded") return;
  if (run.rows[0]?.status !== "staging" || run.rows[0].owner_token !== ownerToken || !run.rows[0].lease_live) {
    throw new Error(`NFS index sync run ${runId} is not owned by a live claimant`);
  }
  await client.query(
    `UPDATE nfs_index_sync_runs
     SET heartbeat_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => $3),
         updated_at = clock_timestamp()
     WHERE id = $1 AND owner_token = $2 AND status = 'staging'`,
    [runId, ownerToken, leaseSeconds],
  );
  const lockedActive = await client.query<ActiveRow>(
    `SELECT entry_id, revision_id, content_hash, file_id, generation_id
     FROM nfs_index_entries
     WHERE repository_id = $1 AND lifecycle = 'active'
     ORDER BY entry_id FOR UPDATE`,
    [repositoryId],
  );
  if (JSON.stringify(lockedActive.rows) !== JSON.stringify(active)) {
    throw new Error("Active NFS index changed while this snapshot was staged; restart synchronization");
  }
  const staged = await client.query<{ entry_id: string; payload_hash: string; projector_version: number }>(
    `SELECT entry_id, payload_hash, projector_version
     FROM nfs_index_sync_staging WHERE run_id = $1 ORDER BY ordinal FOR UPDATE`,
    [runId],
  );
  if (
    staged.rows.length !== projections.length
    || staged.rows.some((row, index) =>
      row.entry_id !== projections[index].entryId
      || row.projector_version !== CONTENT_INDEX_PROJECTOR_VERSION
      || row.payload_hash !== entryProjectionHash(projections[index])
    )
  ) {
    throw new Error("Persisted NFS index staging checkpoint does not match the validated canonical snapshot");
  }
  await client.query(
    `UPDATE nfs_index_sync_runs SET status = 'applying', updated_at = now()
     WHERE id = $1 AND owner_token = $2 AND status = 'staging'`,
    [runId, ownerToken],
  );

  const desiredByFile = Map.groupBy(projections, (entry) => entry.fileUuid);
  const desiredBoundFileIds = new Set<string>();
  const changedEntries = new Set([...plan.additions, ...plan.updates, ...plan.removals]);
  const affectedFiles = new Set(active.filter((entry) => changedEntries.has(entry.entry_id)).map((entry) => entry.file_id));
  for (const entry of projections) if (changedEntries.has(entry.entryId)) affectedFiles.add(entry.fileUuid);

  for (const entries of desiredByFile.values()) {
    if (!affectedFiles.has(entries[0].fileUuid)) continue;
    const binding = await resolveNfsManagedSourceAndFile(client, repositoryId, entries[0]);
    desiredBoundFileIds.add(binding.fileId);
    await activateManagedGeneration(client, entries[0], binding);
    await upsertFileIndexRows(client, repositoryId, entries, binding);
  }

  if (plan.removals.length > 0) {
    await client.query(
      `UPDATE nfs_index_entries SET lifecycle = 'retired', retired_at = now()
       WHERE repository_id = $1 AND entry_id = ANY($2::text[]) AND lifecycle = 'active'`,
      [repositoryId, plan.removals],
    );
  }
  for (const fileId of affectedFiles) {
    if (desiredByFile.has(fileId) || desiredBoundFileIds.has(fileId)) continue;
    await client.query(
      `UPDATE ingestion_generations SET status = 'archived', archived_at = now()
       WHERE id = (SELECT active_generation_id FROM files WHERE id = $1) AND status = 'active'
         AND EXISTS (SELECT 1 FROM nfs_index_managed_files WHERE file_id = $1 AND repository_id = $2 AND owns_file)`,
      [fileId, repositoryId],
    );
    await client.query(`UPDATE files SET active_generation_id = NULL, deleted_at = now() WHERE id = $1
      AND EXISTS (SELECT 1 FROM nfs_index_managed_files WHERE file_id = $1 AND repository_id = $2 AND owns_file)`, [fileId, repositoryId]);
  }
  await client.query(
    `UPDATE sources s SET deleted_at = now()
      WHERE EXISTS (SELECT 1 FROM nfs_index_managed_sources ms WHERE ms.source_id = s.id AND ms.repository_id = $1 AND ms.owns_source)
       AND NOT EXISTS (SELECT 1 FROM files f WHERE f.source_id = s.id AND f.deleted_at IS NULL)`,
    [repositoryId],
  );
  await client.query(
    `UPDATE nfs_index_sync_runs SET status = 'succeeded', error_summary = NULL, finished_at = now(), updated_at = now()
     WHERE id = $1 AND owner_token = $2 AND status = 'applying'`,
    [runId, ownerToken],
  );
}

export async function resolveNfsManagedSourceAndFile(
  client: Queryable,
  repositoryId: string,
  entry: IndexedEntryProjection,
): Promise<NfsManagedBinding> {
  const source = entry.source;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('nfs-canonical-source:' || $1, 0))", [source.sourceId]);
  const sourceResult = await client.query<Record<string, unknown> & QueryResultRow>(
    `SELECT s.*, mapping.repository_id AS mapping_repository_id, mapping.owns_source
     FROM sources s LEFT JOIN nfs_index_managed_sources mapping ON mapping.source_id = s.id
     WHERE s.canonical_source_id = $1 FOR UPDATE OF s`, [source.sourceId],
  );
  let sourceId: string;
  let ownsSource: boolean;
  if (sourceResult.rows[0]) {
    validateReusableSource(sourceResult.rows[0], source);
    if (sourceResult.rows[0].mapping_repository_id != null && sourceResult.rows[0].mapping_repository_id !== repositoryId) throw new Error(`Canonical source ${source.sourceId} is managed by another repository.`);
    sourceId = String(sourceResult.rows[0].id);
    ownsSource = sourceResult.rows[0].mapping_repository_id === repositoryId && sourceResult.rows[0].owns_source === true;
  } else {
    const collision = await client.query("SELECT id FROM sources WHERE id = $1 FOR UPDATE", [entry.sourceUuid]);
    if (collision.rows[0]) throw new Error(`Deterministic NFS source identity for ${entry.entryId} conflicts with existing content.`);
    await client.query(
    `INSERT INTO sources
       (id, title, category, edition, language, access_tier, shared, owner_user_id, metadata,
        canonical_source_id, publication_code, publication_title, publisher, release_year,
        publication_revision, external_origin_url, external_origin_id, attribution, source_priority,
        canonical_book_id, license, deleted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NULL)`,
    [entry.sourceUuid, source.title, source.category, source.edition, source.language, source.accessTier,
      source.shared, source.ownerUserId, JSON.stringify({ managedBy: "nfs-content-index", repositoryId }),
      source.sourceId, source.publication.code, source.publication.title, source.publication.publisher,
      source.publication.releaseYear, source.publication.revision ?? null, source.publication.origin?.url ?? null,
      source.publication.origin?.id ?? null, source.publication.attribution ?? null,
      source.publication.sourcePriority, source.publication.canonicalBookId, source.license ?? null],
    );
    sourceId = entry.sourceUuid;
    ownsSource = true;
  }
  await client.query(
    `INSERT INTO nfs_index_managed_sources (source_id, repository_id, canonical_source_id, owns_source)
     VALUES ($1,$2,$3,$4) ON CONFLICT (source_id) DO UPDATE SET
       repository_id=EXCLUDED.repository_id, canonical_source_id=EXCLUDED.canonical_source_id,
       owns_source=nfs_index_managed_sources.owns_source
     WHERE nfs_index_managed_sources.repository_id=EXCLUDED.repository_id`,
    [sourceId, repositoryId, source.sourceId, ownsSource],
  );

  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('nfs-canonical-file:' || $1, 0))", [entry.file.fileId]);
  const fileResult = await client.query<Record<string, unknown> & QueryResultRow>(
    `SELECT f.*, mapping.repository_id AS mapping_repository_id, mapping.owns_file
     FROM files f LEFT JOIN nfs_index_managed_files mapping ON mapping.file_id = f.id
     WHERE f.id::text = $1 FOR UPDATE OF f`, [entry.file.fileId],
  );
  let fileId: string;
  let ownsFile: boolean;
  if (fileResult.rows[0]) {
    validateReusableFile(fileResult.rows[0], sourceId, entry);
    if (fileResult.rows[0].mapping_repository_id != null && fileResult.rows[0].mapping_repository_id !== repositoryId) throw new Error(`Canonical file ${entry.file.fileId} is managed by another repository.`);
    fileId = String(fileResult.rows[0].id);
    ownsFile = fileResult.rows[0].mapping_repository_id === repositoryId && fileResult.rows[0].owns_file === true;
  } else {
    const collision = await client.query("SELECT id FROM files WHERE id = $1 FOR UPDATE", [entry.fileUuid]);
    if (collision.rows[0]) throw new Error(`Deterministic NFS file identity for ${entry.entryId} conflicts with existing content.`);
    await client.query(
    `INSERT INTO files
       (id, source_id, original_filename, mime_type, checksum_sha256, byte_size, storage_path, deleted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)`,
    [entry.fileUuid, sourceId, sourceFilename(entry.file.path), entry.file.mediaType,
       entry.file.contentHash.slice("sha256:".length), entry.file.byteSize, entry.file.path],
    );
    fileId = entry.fileUuid;
    ownsFile = true;
  }
  await client.query(
    `INSERT INTO nfs_index_managed_files (file_id, source_id, repository_id, canonical_file_id, owns_file)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (file_id) DO UPDATE SET
       source_id=EXCLUDED.source_id, repository_id=EXCLUDED.repository_id,
       canonical_file_id=EXCLUDED.canonical_file_id, owns_file=nfs_index_managed_files.owns_file
     WHERE nfs_index_managed_files.repository_id=EXCLUDED.repository_id`,
    [fileId, sourceId, repositoryId, entry.file.fileId, ownsFile],
  );
  return { sourceId, fileId, ownsSource, ownsFile };
}

function validateReusableSource(row: Record<string, unknown>, source: IndexedEntryProjection["source"]): void {
  const expected: Readonly<Record<string, unknown>> = {
    title: source.title, category: source.category, edition: source.edition, language: source.language,
    access_tier: source.accessTier, shared: source.shared, owner_user_id: source.ownerUserId,
    publication_code: source.publication.code, publication_title: source.publication.title,
    publisher: source.publication.publisher, release_year: source.publication.releaseYear,
    publication_revision: source.publication.revision ?? null, external_origin_url: source.publication.origin?.url ?? null,
    external_origin_id: source.publication.origin?.id ?? null, attribution: source.publication.attribution ?? null,
    source_priority: source.publication.sourcePriority, canonical_book_id: source.publication.canonicalBookId,
    license: source.license ?? null, deleted_at: null,
  };
  const conflict = Object.entries(expected).find(([key, value]) => row[key] !== value);
  if (conflict) throw new Error(`Canonical source ${source.sourceId} conflicts on ${conflict[0]}; refusing to co-mingle source metadata or access.`);
}

function validateReusableFile(row: Record<string, unknown>, sourceId: string, entry: IndexedEntryProjection): void {
  const expected: Readonly<Record<string, unknown>> = {
    source_id: sourceId, mime_type: entry.file.mediaType,
    checksum_sha256: entry.file.contentHash.slice("sha256:".length), deleted_at: null,
  };
  const conflict = Object.entries(expected).find(([key, value]) => row[key] !== value);
  if (conflict) throw new Error(`Canonical file ${entry.file.fileId} conflicts on ${conflict[0]}; refusing to reuse incompatible file content.`);
  if (Number(row.byte_size) !== entry.file.byteSize) throw new Error(`Canonical file ${entry.file.fileId} conflicts on byte_size; refusing to reuse incompatible file content.`);
}

async function activateManagedGeneration(client: Queryable, entry: IndexedEntryProjection, binding: NfsManagedBinding): Promise<void> {
  await client.query(
    `UPDATE ingestion_generations SET status='archived', archived_at=now()
     WHERE file_id=$1 AND status='active' AND id<>$2`,
    [binding.fileId, entry.generationId],
  );
  await client.query(
    `INSERT INTO ingestion_generations (id, source_id, file_id, status, activated_at)
     VALUES ($1,$2,$3,'active',now())
     ON CONFLICT (id) DO UPDATE SET status='active', archived_at=NULL`,
    [entry.generationId, binding.sourceId, binding.fileId],
  );
  await client.query("UPDATE files SET active_generation_id=$2, deleted_at=NULL WHERE id=$1", [binding.fileId, entry.generationId]);
}

async function upsertFileIndexRows(
  client: Queryable,
  repositoryId: string,
  entries: readonly IndexedEntryProjection[],
  binding: NfsManagedBinding,
): Promise<void> {
  const first = entries[0];
  await reconcileManagedProjectionRows(client, repositoryId, entries);
  const pages = new Map<number, string[]>();
  const pageCitations = new Map<number, IndexedEntryProjection["pages"][number]["citations"]>();
  for (const entry of entries) {
    await client.query(
      `INSERT INTO documents (id, source_id, file_id, generation_id, title, document_type, text, metadata)
       VALUES ($1,$2,$3,$4,$5,'canonical-revision',$6,$7::jsonb)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, text=EXCLUDED.text, metadata=EXCLUDED.metadata`,
       [entry.documentId, binding.sourceId, binding.fileId, entry.generationId, entry.name, entry.plainText,
        JSON.stringify({ managedBy: "nfs-content-index", repositoryId, entryId: entry.entryId, revisionId: entry.revisionId })],
    );
    for (const page of entry.pages) {
      pages.set(page.pageNumber, [...(pages.get(page.pageNumber) ?? []), page.text]);
      pageCitations.set(page.pageNumber, [...(pageCitations.get(page.pageNumber) ?? []), ...page.citations]);
    }
  }
  const pageIds = new Map<number, string>();
  for (const [pageNumber, texts] of [...pages].sort(([left], [right]) => left - right)) {
    const pageId = deterministicUuid("nfs-index-page", repositoryId, first.generationId, String(pageNumber));
    pageIds.set(pageNumber, pageId);
    await client.query(
      `INSERT INTO pages (id, source_id, file_id, generation_id, page_number, text, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, metadata=EXCLUDED.metadata`,
      [pageId, binding.sourceId, binding.fileId, first.generationId, pageNumber,
        [...new Set(texts)].join("\n\n"), JSON.stringify({
          managedBy: "nfs-content-index",
          repositoryId,
          citations: pageCitations.get(pageNumber) ?? [],
        })],
    );
  }
  for (const entry of entries) {
    const row = nfsIndexEntryRow(repositoryId, entry);
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
        [chunk.id, binding.sourceId, binding.fileId, entry.documentId,
          chunk.pageNumber === null ? null : pageIds.get(chunk.pageNumber) ?? null,
          entry.generationId, chunk.chunkIndex, chunk.text, chunk.quoteText, chunk.sectionHeading,
          chunk.pageNumber, chunk.textSpanStart, chunk.textSpanEnd, JSON.stringify(chunk.metadata)],
      );
    }
    await client.query(
       `INSERT INTO nfs_index_entries
          (id, repository_id, entry_id, revision_id, content_hash, entry_type, name, aliases,
           typed_fields, plain_text, canonical_payload, source_id, file_id, generation_id, document_id,
           edition, language, lifecycle, retired_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,'active',NULL)
       ON CONFLICT (repository_id, entry_id) DO UPDATE SET revision_id=EXCLUDED.revision_id,
         content_hash=EXCLUDED.content_hash, entry_type=EXCLUDED.entry_type, name=EXCLUDED.name,
         aliases=EXCLUDED.aliases, typed_fields=EXCLUDED.typed_fields, plain_text=EXCLUDED.plain_text,
          canonical_payload=EXCLUDED.canonical_payload, source_id=EXCLUDED.source_id,
          file_id=EXCLUDED.file_id, generation_id=EXCLUDED.generation_id,
          document_id=EXCLUDED.document_id, edition=EXCLUDED.edition, language=EXCLUDED.language,
          lifecycle='active', retired_at=NULL, indexed_at=now()`,
      [row.id, row.repository_id, row.entry_id, row.revision_id, row.content_hash, row.entry_type,
        row.name, JSON.stringify(row.aliases), JSON.stringify(row.typed_fields), row.plain_text,
         JSON.stringify(row.canonical_payload), binding.sourceId, binding.fileId, row.generation_id, row.document_id,
        row.edition, row.language],
    );
  }
}

export function nfsIndexEntryRow(repositoryId: string, entry: IndexedEntryProjection) {
  return {
    id: entry.id, repository_id: repositoryId, entry_id: entry.entryId, revision_id: entry.revisionId,
    content_hash: entry.contentHash, entry_type: entry.entryType, name: entry.name, aliases: entry.aliases,
    typed_fields: entry.typedFields, plain_text: entry.plainText, canonical_payload: entry.canonicalPayload,
    source_id: entry.sourceUuid, file_id: entry.fileUuid, generation_id: entry.generationId, document_id: entry.documentId,
    edition: entry.source.edition, language: entry.source.language,
  } as const;
}

export async function reconcileManagedProjectionRows(
  client: Queryable,
  repositoryId: string,
  entries: readonly IndexedEntryProjection[],
): Promise<void> {
  const first = entries[0];
  const desiredDocumentIds = entries.map((entry) => entry.documentId);
  const desiredPageIds = [...new Set(entries.flatMap((entry) => entry.pages.map((page) =>
    deterministicUuid("nfs-index-page", repositoryId, first.generationId, String(page.pageNumber))
  )))];
  const desiredChunkIds = entries.flatMap((entry) => entry.chunks.map((chunk) => chunk.id));
  const collision = await client.query<{ unmanaged_collision: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM documents WHERE id = ANY($1::uuid[]) AND metadata->>'managedBy' IS DISTINCT FROM 'nfs-content-index')
       OR EXISTS (SELECT 1 FROM pages WHERE id = ANY($2::uuid[]) AND metadata->>'managedBy' IS DISTINCT FROM 'nfs-content-index')
       OR EXISTS (SELECT 1 FROM chunks WHERE id = ANY($3::uuid[]) AND metadata->>'managedBy' IS DISTINCT FROM 'nfs-content-index')
       AS unmanaged_collision`,
    [desiredDocumentIds, desiredPageIds, desiredChunkIds],
  );
  if (collision.rows[0]?.unmanaged_collision) {
    throw new Error(`Projection generation ${first.generationId} conflicts with unmanaged index rows`);
  }
  await client.query(
    `DELETE FROM chunks
     WHERE generation_id = $1 AND metadata->>'managedBy' = 'nfs-content-index'
       AND NOT (id = ANY($2::uuid[]))`,
    [first.generationId, desiredChunkIds],
  );
  await client.query(
    `DELETE FROM pages
     WHERE generation_id = $1 AND metadata->>'managedBy' = 'nfs-content-index'
       AND NOT (id = ANY($2::uuid[]))`,
    [first.generationId, desiredPageIds],
  );
  await client.query(
    `DELETE FROM documents
     WHERE generation_id = $1 AND metadata->>'managedBy' = 'nfs-content-index'
       AND NOT (id = ANY($2::uuid[]))`,
    [first.generationId, desiredDocumentIds],
  );
}
