# Compendium Import Review

The admin workspace at `/admin/compendium/imports` exposes successful and failed import runs, candidate status filters, diagnostics, old/new JSON diffs, PDF citation previews, and immutable audit history. It is responsive down to mobile widths and uses cards instead of a fixed-width review table.

## Review safeguards

- Only authenticated administrators can access the pages and APIs.
- Only successful import runs can be reviewed.
- `new`, `changed`, and `unchanged` candidates can be approved directly.
- `invalid` and `duplicate` candidates require an explicit merged JSON payload before publication.
- Only `missing` candidates can enqueue unpublication.
- Bulk mutations lock and validate every selected candidate before persisting any decision.
- Candidate payloads are classified by origin and publication capability. #77 PDF extraction payloads with complete evidence are `publishable`; #78 collector snapshots and unknown payloads are `requires_extraction` and cannot enter publication actions.
- A `missing` row has no current occurrence. It is `can_unpublish` only when its immutable `previous_candidate_id` chain has the same source, file, type, and key; points to prior #77 chunk/page evidence; and has a completed approved or merged publication whose reconstructed revision is still the displayed active CAS target. It can never be approved or merged as new content.
- Every decision and publication transition records actor and timestamp. Terminal outcomes are written by the worker, not by dashboard reads.
- Completed publication rows and audit events are immutable in PostgreSQL.

## Publication boundary

The application does not update `compendium_versions`, `compendium_revisions`, canonical manifests, or canonical NFS paths. Approval and merge deterministically project and validate the immutable #77 extraction payload before creating a canonical revision in memory and calling `submitPublicationCommand`; unpublish calls `submitUnpublicationCommand`. Both write only to the #96 upload spool and enqueue worker work.

Each candidate response includes the exact currently active revision token, including explicit absence. The UI displays and submits that token per candidate, including every member of a bulk action; the mutation service persists it without rereading canonical state. Under the canonical fence the worker rejects the command if the target changed, preventing a later run from being overwritten by a stale page's approval or unpublication. A submission exception leaves the pending attempt and idempotency key unchanged. Only a worker terminal failure enables a new attempt, which uses the token from the newly loaded review response.

Canonical targets use the type-qualified stable identity `<entryType>-<candidateKey>` everywhere: review responses, active-token lookup, publication commands, merge, and unpublication. This keeps identities such as `spell-shield` and `equipment-shield` distinct.

The worker serializes canonical changes and installs an immutable activation delta. Version 1 remains replacement-only and is folded by v1 and v2 repositories. Unpublication uses a version 2 delta whose `entry` is `null`; it is emitted and folded only when the bootstrap declares deletion-capable reader contract v2. Rolling a bootstrap back to v1 makes existing v2 deltas inert while retaining v1 replacements.

## Candidate payload

Approved or merged candidate `content` remains the immutable #77 shape: `title`, `body`, typed `attributes`, field citations, extraction metadata, review metadata, and source boundary. Before review state or queue submission is written, the service revalidates every derived field against the database-owned chunk and exact quote spans. It projects the title and attributes into canonical entry/typed fields, the complete source chunk into contiguous canonical text/sections, and every field citation into canonical source/file/chunk/page/section provenance. Unicode code-point extraction spans are converted to canonical JavaScript text offsets without changing their quoted evidence. Nullable or structured attribute values that the canonical typed-field contract cannot represent are rejected rather than coerced.

#78 snapshot payloads contain normalized HTML/text and source hashes but no canonical chunk/page field evidence. Review responses expose them as `payloadOrigin: "collector_snapshot"` and `publicationCapability: "requires_extraction"`; they require a future canonical extraction pass rather than a manual merge rewrite.

For `missing` candidates, review evidence fields (`locator`, `chunkId`, `page`, and the `evidenceSourceId` / `evidenceFileId` / `evidenceGenerationId` boundary) come from the previous candidate's occurrence and chunk, never from the empty current occurrence. Collector-derived previous chains remain `requires_extraction` and cannot authorize unpublication.

## Migration 0013

`0013_compendium_import_review.sql` is necessary because import candidates from migration 0008 are immutable extraction artifacts and intentionally contain no mutable review or publication state. Migration 0013 adds separate review and append-only audit tables, immutable active-revision expectations, and separate system/initiating audit identities without changing candidate rows or canonical publication tables.

The migration runner executes each file in one transaction and records it in `schema_migrations`. The migration also uses guarded enum/table/index creation and replaceable functions/triggers, so rerunning the SQL after a rolled-back or manually provisioned deployment is safe. Apply it with `npm run db:migrate` before enabling the review routes.
