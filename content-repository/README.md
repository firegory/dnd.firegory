# Portable content repository

`DND_DATA_ROOT` is the absolute or process-relative path to this filesystem contract. The application depends only on ordinary file semantics; deployment infrastructure supplies and mounts the directory.

## Layout

```text
$DND_DATA_ROOT/
  schemas/v1/                       versioned JSON Schemas
  manifests/repository.json         versioned bootstrap descriptor (not resolved state)
  manifests/activations/            immutable fixed-width-generation target deltas
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

Source provenance carries the same authorization meaning as the application model. `open` sources are unowned and not shared, `premium` sources are unowned and shared, and `personal` sources are not shared and require a UUID `ownerUserId`. Portable rebuilds must preserve these fields and apply access filtering before indexing or retrieval.

Each source has a cohesive `publication` object. `canonicalBookId` identifies the conceptual book, while `code`, `releaseYear`, `revision`, `edition`, and `language` identify a particular publication or reprint; this keeps the 2014 and 2024 rules distinct without assigning a new conceptual identity to every printing. External provenance uses an `origin` object whose absolute HTTP(S) `url` and provider `id` must appear together. Runtime projection uses WHATWG parsing to normalize the scheme, host, default ports, dot segments, and other standard URL components, and rejects whitespace or malformed percent escapes. Canonical files must already contain that exact normalized spelling; validation rejects rather than mutates noncanonical source records. Publication text fields must contain a non-whitespace character. `sourcePriority` is an integer from 0 through 1000 used to rank otherwise equivalent sources.

PostgreSQL projects these values into typed `sources` columns rather than storing a second publication object. Migration `0003_source_publication_metadata.sql` sets existing rows' `publication_title` to their current display title and `source_priority` to `0`; `0004_source_publication_constraints.sql` hardens direct-write checks for canonical text, publication codes, and HTTP(S) origins without invalidating HTTP values persisted under `0003`. The hardened `sources_origin_complete` check is installed `NOT VALID`: it rejects invalid new or updated rows immediately, but legacy whitespace or malformed-percent origins do not block the migration. Other values, including canonical IDs, publisher, release year, revision, origin, attribution, and license, remain `NULL` because they cannot be inferred safely. Such legacy rows remain readable and editable but cannot be serialized as canonical `source.json` until the required canonical publication fields are supplied.

After legacy origins have been reviewed and normalized through the admin API, validate the pending constraint explicitly:

```sql
SELECT id, external_origin_url, external_origin_id
FROM sources
WHERE NOT (
  (external_origin_url IS NULL AND external_origin_id IS NULL)
  OR (
    external_origin_url IS NOT NULL
    AND external_origin_id IS NOT NULL
    AND external_origin_id !~ '^[[:space:]]*$'
    AND external_origin_url ~ '^https?://[^%[:space:]/?#]+'
    AND external_origin_url !~ '[[:space:]]'
    AND external_origin_url !~ '%([^0-9A-Fa-f]|[0-9A-Fa-f]([^0-9A-Fa-f]|$)|$)'
  )
);

ALTER TABLE sources VALIDATE CONSTRAINT sources_origin_complete;
```

Migration tests inspect ordering and SQL constraints statically. Live PostgreSQL execution is not available in this repository test environment and remains a deployment verification step.

Revisions are immutable. Their `contentHash` is SHA-256 over UTF-8 canonical JSON of every revision property except the derived `revisionId` and `contentHash`. Canonical JSON recursively sorts object keys, preserves array order, and has no insignificant whitespace. `revisionId` is `rev-` followed by the same lowercase SHA-256 digest. Changing any canonical content therefore creates a new deterministic path.

Only documents with a known integer `schemaVersion` are accepted. Schema version 1 uses JSON Schema draft 2020-12; checked examples are validated in the automated test suite.

Sections are ordered, non-overlapping spans that cover `text.plain` exactly. Citations use offsets into that same text and must reproduce their quote exactly. Repository validation resolves every declared path physically, rejects traversal and symbolic links whose targets leave `DND_DATA_ROOT`, checks manifest-to-revision identity, and verifies source bytes against their hashes. Symbolic links that resolve within the root are permitted. The contract assumes a case-sensitive filesystem with POSIX-style `/` repository paths and atomic publication of immutable revision files; the mount mechanism remains deployment-specific.

Files under `generations`, `snapshots`, and `exports` are derived views. They may be recreated from immutable revisions and are never canonical content.

PostgreSQL index synchronization is documented in [`docs/content-index-sync.md`](../docs/content-index-sync.md). Canonical schema version 1 is complete enough to derive structured index entries, ingestion generations, pages, and chunks without a separate generation artifact manifest. Authentication, sessions, audit history, operational state, and unmanaged content are outside this rebuild boundary and still require PostgreSQL backups.

## Publication ownership and filesystem assumptions

The worker is the only process permitted to mount `DND_DATA_ROOT` read-write. The web application mounts the same repository read-only; it writes complete, validated publication commands to `PUBLICATION_SPOOL_ROOT` and sends only their stable idempotency keys through Redis. The spool must be durable and shared with workers, but it must not be located inside `DND_DATA_ROOT`.

Redis leases coordinate delivery attempts, but they are not the canonical write fence: expiration alone cannot stop a paused writer. PostgreSQL advisory locks reduce ordinary contention but are not trusted for correctness if a remote session disappears while its process remains alive. Before a command is made durable, the app exclusively creates and fsyncs a shared-spool reservation for a 32-digit monotonic generation. Reservation creation is the ordering linearization point. The command, queue delivery, outbox events, and immutable activation delta all carry that generation.

`readerContractVersion: 1` defines the supported delta-fold contract on both the bootstrap descriptor and every activation delta. Each `manifests/activations/<generation>.json` replaces exactly one target entry. Readers first validate the bootstrap structure and schema declarations, then validate and fold deltas independently, keep the greatest generation for each target, and finally validate only the composed entries and referenced revisions. This permits a newer valid delta to repair a missing or corrupt bootstrap target without hiding corruption in an unreplaced target. A late older command cannot regress the same target, while commands for different targets compose. Corrupt deltas, unsupported reader contract versions, mismatched filename generations, and malformed filenames are inert.

Allocation computes its floor from semantically valid complete reservations, commands, and activation deltas. Activation enumeration is shared with the reader and accepts only regular no-follow files physically within `DND_DATA_ROOT` whose revisions and source evidence validate. Starting above that floor, allocation chooses the first generation whose reservation filename is absent. Every exact 32-digit reservation filename is a permanent consumed tombstone regardless of its bytes, so corrupt records can never permit exact reuse; far corrupt names, including all-nines, are skipped only if reached and cannot force exhaustion. A new reservation is written and fsynced under a unique temporary name before an exclusive hard link atomically exposes the complete final record. Link collisions trigger a rescan, and a crash before linking consumes nothing. The submitter revalidates reservation checksum, generation, and command identity immediately before immutable command persistence, reallocating above the new floor if ownership was lost. Complete reservations from the earlier unchecksummed format are atomically upgraded in place. `manifests/repository.json` remains bootstrap state and is never replaced by publication.

Supported consumers must use the version-one delta-fold resolver (`loadResolvedRepositoryManifest` in the application) rather than treating `manifests/repository.json` as the active manifest. Repository tooling may use `repositoryBootstrapPath` or `loadRepositoryBootstrapDescriptor` only when it explicitly needs descriptor metadata or schema declarations. There is intentionally no dynamically overwritten compatibility snapshot because a stale writer could regress it.

Queue deliveries have unique IDs and visibility deadlines. Workers renew visibility with an ownership-checked Redis operation throughout publication. Acknowledgement, retry, renewal, and dead-letter transitions compare the current reservation ID; periodic recovery requeues only expired reservations and never drains another live worker's processing set. Lock contention requeues without consuming the bounded failure budget. Other transient failures use bounded exponential retry. Malformed deliveries, missing spool commands, schema/integrity failures, and exhausted retries are removed from active processing and recorded in both the Redis dead-letter list and the durable spool quarantine.

The spool is a durable filesystem outbox. Command and state-event files are fsynced, followed by their containing directory, before Redis enqueue. Each recognized immutable event is validated independently against its filename and command generation; corrupt events are quarantined while remaining valid events still fold with terminal precedence `completed > failed > queued > pending`, then generation and event ID. If no valid event remains, the immutable command safely reconstructs pending state for reconciliation. Workers load the command and compare delivery generation before reading outbox state, so a mismatched delivery is quarantined without poisoning command state. Completion is durably recorded before acknowledgement.

A revision is written and fsynced to a unique timestamped temporary file under `.publication-staging/<entryId>/`, atomically renamed to deterministic staging, and then renamed to its deterministic immutable revision path. Each rename is followed by directory fsync. Cleanup considers only recognized regular temporary files whose actual filesystem modification time is older than 24 hours; a misleading timestamp in the filename cannot remove a newly created active temporary. Readers discover revisions by folding valid immutable target deltas over bootstrap `repository.json`. A crash before delta installation leaves the previous target state active.

The canonical mount must provide these filesystem properties:

- `DND_DATA_ROOT`, `.publication-staging`, `compendium`, and `manifests` are one filesystem and one mount. Cross-filesystem renames are not supported.
- Rename within that mount is atomic, and a renamed, closed file becomes visible to other clients without exposing partial bytes. Standard NFS server-side rename and close-to-open cache consistency satisfy the publication protocol; unusual attribute/data caching settings must preserve those guarantees.
- File and directory `fsync` calls report durable server-side completion. Deployments that acknowledge writes only in volatile client or server caches need an additional durability policy.
- The filesystem is case-sensitive and preserves the POSIX path behavior required by the repository contract.
- Canonical directories are not symbolic links. The worker walks existing mutation ancestors with `lstat`, creates missing directories one component at a time, and opens temporary files with `O_NOFOLLOW`. Node.js does not expose an `openat2`-style operation for an entirely race-free path walk, so deployment permissions must enforce the documented worker-only writer model; untrusted processes must not be able to rename canonical directories concurrently.

Redis coordinates delivery attempts and queue recovery; it is neither the write fence nor canonical storage. Redis should use persistence appropriate to the deployment. If a command delivery is lost, outbox reconciliation or resubmitting its idempotency key is safe because the spool record and deterministic revision identity remain authoritative.
