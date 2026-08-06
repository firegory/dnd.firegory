# Portable Agent Corpus Exports

Corpus exports are deterministic, derived views of the canonical content repository under `DND_DATA_ROOT`. They let trusted filesystem agents and offline tools consume complete entries, citations, source provenance, and incremental changes without PostgreSQL. They do not call an embedding provider and do not read or modify embeddings.

Exports are **noncanonical**. Canonical revisions, source records, source files, and resolved activation state remain authoritative. Every artifact repeats this status or is covered by a manifest that does.

## Commands

```bash
npm run corpus-export -- generate [--data-root <path>]
npm run corpus-export -- generate [--data-root <path>] [--from <export-id>] [--no-latest]
npm run corpus-export -- validate [--data-root <path>] [--export <export-id>]
```

`generate` uses the same #102 resolver as NFS index synchronization. It folds valid activation deltas and validates the repository manifest, declared JSON Schemas, canonical revision identities, source records, citations, and source-file hashes before writing an export. No database connection is made.

By default, the versioned `exports/latest.json` reader contract and greatest valid record under `exports/latest/` supply the incremental comparison boundary. `--from` selects an immutable earlier export explicitly. The first export is a full boundary: every active entry is an addition. `--no-latest` creates and validates the immutable export without publishing a latest record.

`validate` defaults to the export referenced by the greatest valid latest record. It is also database-free.

## Layout

```text
$DND_DATA_ROOT/exports/
  latest.json                       immutable versioned reader descriptor
  latest/
    <32-digit-generation>.json      immutable validated latest-pointer records
  corpus-<sha256>/
    manifest.json                   artifact hashes, byte sizes, boundary, provenance
    catalog.json                    ordered active revisions, sources, schema versions/hashes
    sources.json                    complete source records and verified source-file metadata
    entries.jsonl                   one complete active entry per line
    entries.md                      deterministic human/agent-readable complete revisions
    changes.json                    additions, updates, removals, from/to boundary
    changes.jsonl                   changed entries and removal tombstones
    README.md                       format guidance and noncanonical warning
```

Each `entries.jsonl` record embeds the complete validated canonical revision, including typed entry data, plain text, sections, citations with exact quotes and offsets, and source provenance. `sources.json` adds verified byte sizes to each canonical source-file path and hash. A consumer therefore needs no database lookup to interpret an entry or resolve its citation to a source file in the repository.

Removal records contain `entryId`, `previousRevisionId`, and `previousContentHash`; they intentionally contain no current entry. Additions and updates embed the exact corresponding full entry record. Updates also carry the predecessor revision ID and content hash.

## Determinism And Integrity

- Entry, source, file, schema, and change lists use UTF-8 byte ordering by stable ID.
- JSON artifacts use recursively key-sorted canonical JSON with one trailing newline.
- JSONL has exactly one canonical JSON record per line and one trailing newline when nonempty.
- Markdown uses a fixed rendering of the same complete revisions represented in JSONL.
- `catalog.json` records each declared canonical schema's version and SHA-256 bytes.
- `manifest.json` records SHA-256 and byte size for every export artifact.
- Derived format version 2 rejects unknown fields and requires canonical bytes for every JSON and JSONL artifact.
- The export ID is derived from the catalog hash plus the hashes of both change artifacts, binding the complete incremental contract into immutable identity.
- Re-running unchanged resolved input revalidates and reuses the existing export byte-for-byte.

Validation loads the declared predecessor export, recursively validates its chain, recomputes the actual catalog diff, and verifies every addition, update, removal, and previous hash. It also recomputes artifact hashes and cross-checks strict catalogs, source records, complete canonical revision identities, citation spans, JSONL changes, tombstones, README, and exact Markdown rendering. Display names and source titles are Markdown-escaped and HTML-encoded. An invalid artifact is never published as latest.

## Atomic Publication

Generation writes and `fsync`s every artifact in a private staging directory, validates the complete staged export, atomically renames it to its immutable content-derived directory, and `fsync`s `exports/`. Export directories and artifacts must be physical no-follow children of `exports`; symbolic links and escaping paths are rejected.

`latest.json` is an immutable descriptor with an explicit reader contract version. Current state is represented only by complete immutable records under `latest/`. Readers validate records independently and choose the greatest valid fixed-width publication generation; corrupt files, symlinks, malformed generation names, and crash temporaries are inert.

Latest publication re-resolves the canonical NFS snapshot immediately before preparing a record and rejects lower canonical activation generations. It writes and `fsync`s a unique temporary record, then atomically hard-links it to the next unoccupied generation. A collision causes the writer to rescan and repeat canonical/latest validation before trying another generation. Recognized occupied generation names are tombstones, so corrupt records cannot be reused, while a far corrupt name cannot force the allocation floor forward. There is no lease or crash-persistent lock: process death can leave only an ignored temporary, and a later publisher proceeds immediately. A paused stale writer either collides with the newer record and fails its repeated canonical check or publishes a lower generation that readers permanently supersede.

The canonical repository's worker-only write and NFS rename/durability assumptions also apply to exports. Agents should mount the repository read-only and must enforce source access metadata before exposing exported personal or premium content.
