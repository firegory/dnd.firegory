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

Source provenance carries the same authorization meaning as the application model. `open` sources are unowned and not shared, `premium` sources are unowned and shared, and `personal` sources are not shared and require a UUID `ownerUserId`. Portable rebuilds must preserve these fields and apply access filtering before indexing or retrieval.

Each source has a cohesive `publication` object. `canonicalBookId` identifies the conceptual book, while `code`, `releaseYear`, `revision`, `edition`, and `language` identify a particular publication or reprint; this keeps the 2014 and 2024 rules distinct without assigning a new conceptual identity to every printing. External provenance uses an `origin` object whose absolute HTTPS `url` and provider `id` must appear together. Runtime projection uses WHATWG parsing to normalize the scheme, host, and other standard URL components, and rejects whitespace or malformed percent escapes. Publication text fields must contain a non-whitespace character. `sourcePriority` is an integer from 0 through 1000 used to rank otherwise equivalent sources.

PostgreSQL projects these values into typed `sources` columns rather than storing a second publication object. Migration `0003_source_publication_metadata.sql` sets existing rows' `publication_title` to their current display title and `source_priority` to `0`; `0004_source_publication_constraints.sql` hardens direct-write checks for canonical text, publication codes, and HTTPS origins. Other values, including canonical IDs, publisher, release year, revision, origin, attribution, and license, remain `NULL` because they cannot be inferred safely. Such legacy rows remain readable and editable but cannot be serialized as canonical `source.json` until the required canonical publication fields are supplied.

Migration tests inspect ordering and SQL constraints statically. Live PostgreSQL execution is not available in this repository test environment and remains a deployment verification step.

Revisions are immutable. Their `contentHash` is SHA-256 over UTF-8 canonical JSON of every revision property except the derived `revisionId` and `contentHash`. Canonical JSON recursively sorts object keys, preserves array order, and has no insignificant whitespace. `revisionId` is `rev-` followed by the same lowercase SHA-256 digest. Changing any canonical content therefore creates a new deterministic path.

Only documents with a known integer `schemaVersion` are accepted. Schema version 1 uses JSON Schema draft 2020-12; checked examples are validated in the automated test suite.

Sections are ordered, non-overlapping spans that cover `text.plain` exactly. Citations use offsets into that same text and must reproduce their quote exactly. Repository validation resolves every declared path physically, rejects traversal and symbolic links whose targets leave `DND_DATA_ROOT`, checks manifest-to-revision identity, and verifies source bytes against their hashes. Symbolic links that resolve within the root are permitted. The contract assumes a case-sensitive filesystem with POSIX-style `/` repository paths and atomic publication of immutable revision files; the mount mechanism remains deployment-specific.

Files under `generations`, `snapshots`, and `exports` are derived views. They may be recreated from immutable revisions and are never canonical content.
