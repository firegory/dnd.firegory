# Compendium relational core

Migration `0007_compendium_relational_core.sql` adds the normalized storage core. It is additive and does not project or modify existing source, file, generation, or chunk rows. Import extraction and review workflow remain part of issue #75.

## Identity and access boundary

`compendium_entries` is the stable conceptual identity, scoped by `(entry_type, edition, canonical_key)`. A `compendium_version` is one language rendering backed by exactly one source and one file. Composite foreign keys require its edition/language to match that source and its file to belong to that source. Consequently, text from open, premium, and personal sources cannot be combined in one version; separate source-backed versions are required.

The source remains the authorization boundary. This schema does not add query-layer RBAC.

## Revisions and publication

Revision title, body, extension data, citations, and typed projection are immutable after publication. Revision rows permit only the `draft` to `published` lifecycle transition. Draft versions deliberately have no active revision. Published and retired versions must have exactly one non-null active pointer to a published revision belonging to that version; a deferred constraint trigger validates the policy at transaction commit.

The application service locks the version and candidate revision, publishes the revision, then changes the active pointer in the same transaction. Older published revisions remain immutable history.

## Names

Slugs and aliases are rows in `compendium_names`. Both normalize case, whitespace, and punctuation to a hyphenated lookup form and share the unique scope `(entry_type, edition, language, normalized_name)`. Therefore an alias cannot shadow either another alias or a canonical slug in the same browse scope. One partial unique index permits one slug per version. Slugs must already be in normalized stable-key form.

## Relations and provenance

Initial relation kinds are typed by `compendium_relation_type`. Both endpoints carry the same edition through composite foreign keys; cross-edition relations are rejected by both PostgreSQL and `CompendiumService`. A future explicit cross-edition relation kind should use a separate policy rather than weakening this invariant.

Import runs and occurrences retain source, file, generation, optional chunk, locator, and fingerprint provenance. `compendium_import_links` links each occurrence to exactly one produced entry, version, revision, or relation through real foreign keys. No extraction workflow is implemented here.

Citations reference a revision, its source-bound version, and an exact `(chunk, generation, file, source)` owner tuple. Quotes are immutable snapshots with zero-based, half-open offsets into `chunks.quote_text`. A trigger and the service both require `quote` to exactly equal that span. Field citations use JSON-style paths such as `$.duration`; block citations have no field path. Ordered citation rows replace arrays of chunk IDs.

## Typed projections

The initial projections are spells, creatures, items, classes, features, species, backgrounds, feats, and equipment. Their browse/filter fields use typed columns, enums, ranges, and indexes. Generated entry-type discriminators reference the revision's type, preventing a projection from attaching to the wrong domain. `extension_data` must be a JSON object and is reserved for namespaced fields not yet promoted to the relational model; known fields must not be duplicated there.

## Verification

`tests/db/compendium-migration.test.mts` statically verifies migration contracts because the development environment may not provide PostgreSQL. These tests do not claim that regex inspection executes PostgreSQL DDL. Apply the migration against PostgreSQL 16 with `npm run db:migrate` in an environment with `DATABASE_URL` to exercise the live constraints.
