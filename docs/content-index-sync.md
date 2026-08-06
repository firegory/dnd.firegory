# NFS Content Index Synchronization

The canonical repository under `DND_DATA_ROOT` is sufficient to reconstruct the PostgreSQL search index. The synchronizer always uses the resolved manifest produced by folding valid activation deltas; it never indexes the bootstrap descriptor as if it were current state.

## Commands

```bash
npm run content-index -- validate
npm run content-index -- incremental --dry-run
npm run content-index -- incremental
npm run content-index -- clean
npm run content-index -- backfill-embeddings --batch-size 20
```

Use `--data-root <path>` with `validate`, `clean`, or `incremental` to override `DND_DATA_ROOT`. `validate` does not connect to PostgreSQL. Output is JSON and includes deterministic additions, updates, and removals.

## Safety Model

The complete resolved repository is schema-validated and hash-validated before the first database query. A corrupt manifest, unsupported schema version, mismatched revision identity, inconsistent source record, or changed source file therefore cannot start or resume a database run.

Entries are projected deterministically in entry-ID order. UUIDs for managed sources, files, ingestion generations, documents, pages, chunks, and structured index entries are content-derived. Embeddings are deliberately absent from this projection. An unchanged incremental run performs no database writes and preserves existing embeddings.

Non-empty runs persist one validated JSON staging row per entry in `nfs_index_sync_staging`. The run's `staged_entries` value is its restart checkpoint. Restarting the same mode and manifest hash skips completed entries. Staging is not visible to retrieval. Final source/file/generation/document/page/chunk activation and entry retirement occur in one PostgreSQL transaction under a repository advisory lock. A failure rolls back the entire active-index change; the failed run remains resumable.

Only sources and files registered in `nfs_index_managed_sources` and `nfs_index_managed_files`, and entries registered in `nfs_index_entries`, are owned by this process. Removed entries are retired. A managed file is soft-deleted only when the resolved repository no longer assigns any entry to it. Uploaded, manually created, or otherwise unmanaged content is never selected for retirement.

## Rebuild Boundary

The following data is rebuildable from canonical NFS content:

- `nfs_index_entries`, including generic structured fields and the complete canonical payload
- NFS-managed rows in `sources` and `files`
- NFS-managed rows in `ingestion_generations`, `documents`, `pages`, and `chunks`
- Missing `chunks.embedding` values, as a separate derived backfill

The canonical revision schema already contains complete source provenance, text sections, citations, typed fields, and source-file hashes. Consequently, schema version 1 does not require a separate NFS ingestion-generation artifact manifest. PostgreSQL ingestion generations created by sync are derived activation snapshots. If a later canonical schema relies on files under `generations/`, it must first add and declare a versioned JSON Schema containing at least the artifact schema version, generation ID, owning source/file IDs, ordered artifact paths, and SHA-256 hashes; sync must validate that manifest and every artifact before staging.

The following data is **not rebuildable** from the canonical repository and is never read, updated, retired, truncated, or deleted by these commands:

- `users`, password hashes, roles, and profile data
- `sessions` and authentication tokens
- `search_events`, `rag_events`, and any other audit or diagnostic history
- ingestion job history, publication outbox state, and other operational records
- uploaded or manually managed content outside the NFS ownership tables

NFS synchronization is not a PostgreSQL restore procedure. Continue backing up the complete database for authentication, sessions, audit history, operational state, and any content not managed by this synchronizer.

## Embeddings

Structured sync neither calls an embedding provider nor writes `chunks.embedding` or `chunks.embedding_model` on conflict. `backfill-embeddings` selects only active NFS-managed chunks with a null embedding and uses the existing ingestion embedding configuration. It does not modify canonical NFS files. Provider failures leave the structured index active and can be retried independently.
