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

Revisions are immutable. Their `contentHash` is SHA-256 over UTF-8 canonical JSON of every revision property except the derived `revisionId` and `contentHash`. Canonical JSON recursively sorts object keys, preserves array order, and has no insignificant whitespace. `revisionId` is `rev-` followed by the same lowercase SHA-256 digest. Changing any canonical content therefore creates a new deterministic path.

Only documents with a known integer `schemaVersion` are accepted. Schema version 1 uses JSON Schema draft 2020-12; checked examples are validated in the automated test suite.

Files under `generations`, `snapshots`, and `exports` are derived views. They may be recreated from immutable revisions and are never canonical content.
