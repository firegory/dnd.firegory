# Portable content repository

`DND_DATA_ROOT` is the absolute or process-relative path to this filesystem contract. The application depends only on ordinary file semantics; deployment infrastructure supplies and mounts the directory.

## Layout

```text
$DND_DATA_ROOT/
  schemas/v1/                       versioned JSON Schemas
  manifests/repository.json         discoverable repository index
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

Workers serialize repository publication with a Redis lease scoped to the repository ID. Acquisition uses `SET NX PX`; renewal and release are compare-owner Lua operations, so an old worker cannot renew or delete a replacement worker's lease. The lease is renewed during publication and checked again before each canonical rename. Interrupted reliable-list deliveries are returned from the Redis processing list when a worker starts. Publication commands remain in the spool as durable idempotency records.

A revision is first fsynced under `.publication-staging/<entryId>/`, then renamed to its deterministic immutable revision path. Readers discover revisions only through `manifests/repository.json`. Activation writes and fsyncs a complete temporary manifest in `manifests/`, then atomically renames it over `repository.json`; a crash before that rename leaves the previous manifest active. Retry reuses identical staged or final revision bytes and does not create another revision.

The canonical mount must provide these filesystem properties:

- `DND_DATA_ROOT`, `.publication-staging`, `compendium`, and `manifests` are one filesystem and one mount. Cross-filesystem renames are not supported.
- Rename within that mount is atomic, and a renamed, closed file becomes visible to other clients without exposing partial bytes. Standard NFS server-side rename and close-to-open cache consistency satisfy the publication protocol; unusual attribute/data caching settings must preserve those guarantees.
- File and directory `fsync` calls report durable server-side completion. Deployments that acknowledge writes only in volatile client or server caches need an additional durability policy.
- The filesystem is case-sensitive and preserves the POSIX path behavior required by the repository contract.

Redis coordinates writers and queue recovery; it is not canonical storage. Redis should use persistence appropriate to the deployment. If a command delivery is lost, resubmitting its idempotency key is safe because the spool record and deterministic revision identity remain authoritative.
