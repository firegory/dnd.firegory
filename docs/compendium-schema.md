# Compendium relational core

Migration `0007_compendium_relational_core.sql` adds the normalized storage core. It is additive and does not project or modify existing source, file, generation, or chunk rows. Import extraction and review workflow remain part of issue #75.

## Identity and access boundary

`compendium_entries` is the stable conceptual identity, scoped by `(entry_type, edition, canonical_key)`. A `compendium_version` is one language rendering backed by exactly one source and one file. Composite foreign keys require its edition/language to match that source and its file to belong to that source. Consequently, text from open, premium, and personal sources cannot be combined in one version; separate source-backed versions are required.

The source remains the authorization boundary. This schema does not add query-layer RBAC.

## Revisions and publication

Revision title, body, extension data, citations, and typed projection are immutable once created, including for drafts. Projection and citation rows may only be inserted in the revision's creation transaction and can never be updated, reassigned, or deleted; edits create a new revision. Revision rows permit only the lifecycle-only `draft` to `published` transition. Every version, including a draft, has exactly one non-null active pointer to an owned revision. Draft versions point to draft revisions, while published and retired versions point to published revisions. Both sides of the cyclic foreign key are deferred, and deferred triggers reload the version by ID to validate the final transaction state and matching typed projection.

The application service allocates the initial revision ID while inserting the version, creates the revision and all children in the same transaction, and exposes `createRevision` rather than mutation. Publishing locks the version, candidate revision, and all cited generation rows before changing lifecycle and the active pointer. Older revisions remain immutable history.

## Names

Slugs and aliases are rows in `compendium_names`. Both normalize to Unicode NFC before case folding and replacement of whitespace plus `-_.,/:;!?()` with hyphens. They share the unique scope `(entry_type, edition, language, normalized_name)`, so canonically equivalent composed and decomposed aliases conflict and an alias cannot shadow another alias or slug. One partial unique index permits one slug per version. Slugs must already be in normalized ASCII stable-key form.

Production PostgreSQL must use `server_encoding = 'UTF8'` and provide the deterministic ICU root collation `und-x-icu`; the migration rejects databases missing either capability. Name folding, separator processing, the generated normalized column, and its unique index explicitly use this collation and do not inherit database `LC_CTYPE`. Application preflight uses NFC plus ECMAScript's locale-independent Unicode default case conversion, while database uniqueness remains authoritative.

## Relations and provenance

Initial relation kinds are typed by `compendium_relation_type`. Both endpoints carry the same edition through composite foreign keys; cross-edition relations are rejected by both PostgreSQL and `CompendiumService`. A future explicit cross-edition relation kind should use a separate policy rather than weakening this invariant.

Import runs and occurrences retain source, file, generation, optional chunk, locator, and fingerprint provenance. Separate and composite FKs always enforce run source/file ownership. A locked trigger uses null-safe comparison to require the occurrence generation to exactly equal its run generation, including null/null for non-generation imports, and the run generation becomes immutable after its first occurrence. `compendium_import_links` always carries a source-bound evidence version matching the occurrence source/file. A null optional target means the evidence version represents the produced conceptual entry/version; a revision must belong to that version; and a conceptual relation must originate at the evidence version's entry. Conceptual entries and relations are never linked without this source-bound evidence.

## Resumable import runs

Migration `0008_resumable_compendium_imports.sql` extends the `0007` run and occurrence records rather than replacing them. Every run identity includes its source/file, importer, importer/parser/prompt/model versions, and input SHA-256. For generation-backed runs, the generation is identity-bearing and `ingestion_job_id` is always derived from that generation, so callers that omit the job and callers that supply the matching job resolve the same run. For runs without a generation, the optional job is identity-bearing: different jobs create distinct runs, while repeated requests with the same job or with no job compare null-safely and resolve the existing run. Partial unique indexes enforce these two cases. Version metadata, ownership, and the input hash are immutable.

Workers claim runs with a time-limited database lease. A live lease excludes concurrent workers; after a crash and lease expiry, another worker reclaims the same `running` run. Explicitly failed runs may also be reclaimed. Occurrences and per-occurrence checkpoints are inserted idempotently, so a restarted worker verifies and skips matching completed work rather than recreating it. Checkpoints advance only from `created` to `occurrences` to `diffed` to `completed`; occurrence and candidate writes are rejected outside their phase. Legacy `0007` terminal runs are normalized to compatible checkpoint states before the new constraints are installed. A conflicting replay is rejected. `succeeded` and `cancelled` runs are terminal.

Candidate payloads are immutable JSON objects with canonical content hashes and explicit per-run order. The latest successful run for the same source/file is the comparison baseline. First valid occurrences are classified as `new`, `unchanged`, or `changed`; repeated keys are `duplicate`; rejected parser output is `invalid`; and baseline keys absent from the new run are copied into immutable `missing` review records. Missing records have no current occurrence and do not delete, retire, or unpublish anything. The candidate-diff checkpoint hashes the ordered, canonical representation of every occurrence and candidate identity, ownership field, provenance link, classification, payload, and content hash. Resume and conflict paths reconstruct and verify that manifest rather than trusting a matching row count or payload hash alone.

Diagnostics have stable per-run keys for idempotent retry, and lifecycle/checkpoint events are retained in an append-only audit log. Occurrences, candidates, checkpoints, diagnostics, and audit rows reject updates and deletes. A partial run is any non-terminal leased or lease-expired `running` run; neither partial nor failed runs can back a revision's draft-to-published transition. Publication locks the revision before locking import links and runs; every import-link insert, update, or delete first takes a shared lock on its old/new revisions in deterministic order. These matching lock orders close link/publication races in both `CompendiumService` and direct database writes. This issue does not add extraction, review UI, or publication behavior.

Citations reference a revision, its source-bound version, and an exact `(chunk, generation, file, source)` owner tuple. A citation may only use an active or archived generation, never staged output. Referenced chunk text, quote text, ownership, and generation lifecycle are protected from deletion or incompatible mutation; active-to-archived transitions remain valid, while staged reset/discard remains unaffected because staged chunks cannot be cited.

Quotes are immutable snapshots with zero-based, half-open Unicode code-point offsets into `chunks.quote_text`. PostgreSQL `char_length`/`substring` and application `Array.from` slicing therefore agree even when astral characters such as emoji occur before or inside a quote. A trigger and the service both require `quote` to exactly equal that span. Field citations use JSON-style paths such as `$.duration`; block citations have no field path. Ordered citation rows replace arrays of chunk IDs.

## Typed projections

The initial projections are spells, creatures, items, classes, features, species, backgrounds, feats, and equipment. Their browse/filter fields use typed columns, enums, ranges, and indexes. Generated entry-type discriminators reference the revision's type, preventing a projection from attaching to the wrong domain. Creature challenge ratings are exactly `0`, `1/8`, `1/4`, `1/2`, or an integer from 1 through 30; no decimal rounding is accepted. Application integer and fixed-decimal limits mirror PostgreSQL storage bounds. `extension_data` must be a JSON object and is reserved for namespaced fields not yet promoted to the relational model; known fields must not be duplicated there.

## Verification

`tests/db/compendium-migration.test.mts` statically verifies migration contracts because the development environment may not provide PostgreSQL. These tests do not claim that regex inspection executes PostgreSQL DDL. Apply the migration against PostgreSQL 16 with `npm run db:migrate` in an environment with `DATABASE_URL` to exercise the live constraints.
