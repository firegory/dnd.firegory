# Portable content repository

`DND_DATA_ROOT` is the absolute or process-relative path to this filesystem contract. The application depends only on ordinary file semantics; deployment infrastructure supplies and mounts the directory.

## Layout

```text
$DND_DATA_ROOT/
  schemas/v1/                       versioned JSON Schemas
  manifests/repository.json         discoverable repository index
  manifests/activations/            immutable fixed-width-token active manifests
  sources/<sourceId>/source.json    source provenance
  sources/<sourceId>/files/         original source files, including PDFs
  compendium/<entryId>/revisions/   immutable canonical revision JSON
  generations/<generationId>/       rebuildable processing output
  snapshots/<snapshotId>.json       pinned sets of revisions
  exports/<exportId>/               generated, noncanonical exports
```

All path IDs are lowercase stable IDs containing letters, numbers, and hyphens. Utilities reject separators, dot segments, and unrecognized revision IDs before constructing paths. Relative paths stored in documents are always relative to `DND_DATA_ROOT`.

## Canonical revisions

A canonical revision is self-describing: it embeds source provenance, complete plain text and sections, explicitly typed fields, and quote-safe citations. It can be rendered without PostgreSQL or another external catalog. Source file paths and hashes make the original evidence independently verifiable.

Source provenance carries the same authorization meaning as the application model. `open` sources are unowned and not shared, `premium` sources are unowned and shared, and `personal` sources are not shared and require an `ownerUserId`. Portable rebuilds must preserve these fields and apply access filtering before indexing or retrieval.

Revisions are immutable. Their `contentHash` is SHA-256 over UTF-8 canonical JSON of every revision property except the derived `revisionId` and `contentHash`. Canonical JSON recursively sorts object keys, preserves array order, and has no insignificant whitespace. `revisionId` is `rev-` followed by the same lowercase SHA-256 digest. Changing any canonical content therefore creates a new deterministic path.

Only documents with a known integer `schemaVersion` are accepted. Schema version 1 uses JSON Schema draft 2020-12; checked examples are validated in the automated test suite.

Sections are ordered, non-overlapping spans that cover `text.plain` exactly. Citations use offsets into that same text and must reproduce their quote exactly. Repository validation resolves every declared path physically, rejects traversal and symbolic links whose targets leave `DND_DATA_ROOT`, checks manifest-to-revision identity, and verifies source bytes against their hashes. Symbolic links that resolve within the root are permitted. The contract assumes a case-sensitive filesystem with POSIX-style `/` repository paths and atomic publication of immutable revision files; the mount mechanism remains deployment-specific.

Files under `generations`, `snapshots`, and `exports` are derived views. They may be recreated from immutable revisions and are never canonical content.

## Publication ownership and filesystem assumptions

The worker is the only process permitted to mount `DND_DATA_ROOT` read-write. The web application mounts the same repository read-only; it writes complete, validated publication commands to `PUBLICATION_SPOOL_ROOT` and sends only their stable idempotency keys through Redis. The spool must be durable and shared with workers, but it must not be located inside `DND_DATA_ROOT`.

Redis leases coordinate delivery attempts, but they are not the canonical write fence: expiration alone cannot stop a paused writer. PostgreSQL advisory locks reduce ordinary contention but are not trusted for correctness if a remote session disappears while its process remains alive. The intrinsic fence is an immutable activation manifest under `manifests/activations/<20-digit-token>.json`. PostgreSQL allocates the monotonic token immediately before activation, and active state is the valid activation with the greatest token. A stale lower-token writer may finish, but it cannot overwrite, remove, or supersede a higher activation. `manifests/repository.json` is bootstrap state only and is never replaced by publication.

Activation resolution needs only repository files after publication. On database rebuild, a worker scans activation filenames and advances the PostgreSQL sequence above the filesystem maximum before allocating. Corrupt or incomplete activation files are ignored in descending-token validation, leaving the greatest valid activation authoritative.

Queue deliveries have unique IDs and visibility deadlines. Workers renew visibility with an ownership-checked Redis operation throughout publication. Acknowledgement, retry, renewal, and dead-letter transitions compare the current reservation ID; periodic recovery requeues only expired reservations and never drains another live worker's processing set. Lock contention requeues without consuming the bounded failure budget. Other transient failures use bounded exponential retry. Malformed deliveries, missing spool commands, schema/integrity failures, and exhausted retries are removed from active processing and recorded in both the Redis dead-letter list and the durable spool quarantine.

The spool is a durable filesystem outbox. Command and state-event files are fsynced, followed by their containing directory, before Redis enqueue. State transitions are immutable events; resolution uses terminal precedence `completed > failed > queued > pending`, then delivery generation and event ID. Thus duplicate or concurrent submissions cannot regress completed content. Workers periodically reconcile missing, pending, or stale queued state and redeliver with a new delivery ID. Completion is durably recorded before acknowledgement. Duplicate deliveries are harmless because the stable command key and deterministic revision identity are checked again by the worker.

A revision is written and fsynced to a unique timestamped temporary file under `.publication-staging/<entryId>/`, atomically renamed to deterministic staging, and then renamed to its deterministic immutable revision path. Each rename is followed by directory fsync. Cleanup considers only recognized temporaries older than 24 hours; recent operation files are never removed. Readers discover revisions through the greatest valid immutable activation, falling back to bootstrap `repository.json` only when no activation exists. A crash before activation installation leaves the previous activation active.

The canonical mount must provide these filesystem properties:

- `DND_DATA_ROOT`, `.publication-staging`, `compendium`, and `manifests` are one filesystem and one mount. Cross-filesystem renames are not supported.
- Rename within that mount is atomic, and a renamed, closed file becomes visible to other clients without exposing partial bytes. Standard NFS server-side rename and close-to-open cache consistency satisfy the publication protocol; unusual attribute/data caching settings must preserve those guarantees.
- File and directory `fsync` calls report durable server-side completion. Deployments that acknowledge writes only in volatile client or server caches need an additional durability policy.
- The filesystem is case-sensitive and preserves the POSIX path behavior required by the repository contract.
- Canonical directories are not symbolic links. The worker walks existing mutation ancestors with `lstat`, creates missing directories one component at a time, and opens temporary files with `O_NOFOLLOW`. Node.js does not expose an `openat2`-style operation for an entirely race-free path walk, so deployment permissions must enforce the documented worker-only writer model; untrusted processes must not be able to rename canonical directories concurrently.

Redis coordinates delivery attempts and queue recovery; it is neither the write fence nor canonical storage. Redis should use persistence appropriate to the deployment. If a command delivery is lost, outbox reconciliation or resubmitting its idempotency key is safe because the spool record and deterministic revision identity remain authoritative.
