# Compendium Import Review

The admin workspace at `/admin/compendium/imports` exposes successful and failed import runs, candidate status filters, diagnostics, old/new JSON diffs, PDF citation previews, and immutable audit history. It is responsive down to mobile widths and uses cards instead of a fixed-width review table.

## Review safeguards

- Only authenticated administrators can access the pages and APIs.
- Only successful import runs can be reviewed.
- `new`, `changed`, and `unchanged` candidates can be approved directly.
- `invalid` and `duplicate` candidates require an explicit merged JSON payload before publication.
- Only `missing` candidates can enqueue unpublication.
- Bulk mutations lock and validate every selected candidate before persisting any decision.
- Every decision, queue transition, failure, and observed worker completion records actor and timestamp.
- Completed publication rows and audit events are immutable in PostgreSQL.

## Publication boundary

The application does not update `compendium_versions`, `compendium_revisions`, canonical manifests, or canonical NFS paths. Approval and merge create a validated canonical revision in memory and call `submitPublicationCommand`; unpublish calls `submitUnpublicationCommand`. Both write only to the #96 upload spool and enqueue worker work.

The worker serializes canonical changes and installs an immutable activation delta. Unpublication is represented by a delta whose `entry` is `null`. Until that final delta is atomically installed, readers continue resolving the previous active revision. A staging, validation, lease, queue, or activation failure therefore leaves active content unchanged. Failed review publications retain their decision and can be retried with a new idempotency key.

## Candidate payload

Approved or merged candidate `content` must contain canonical `entry`, `text`, and `citations` objects accepted by `canonical-revision.schema.json`. Source and file provenance are projected from the run's database-owned source boundary. Complete canonical publication metadata is required before queueing.

## Migration 0013

`0013_compendium_import_review.sql` is necessary because import candidates from migration 0008 are immutable extraction artifacts and intentionally contain no mutable review or publication state. Migration 0013 adds separate review and append-only audit tables without changing candidate rows or canonical publication tables.

The migration runner executes each file in one transaction and records it in `schema_migrations`. The migration also uses guarded enum/table/index creation and replaceable functions/triggers, so rerunning the SQL after a rolled-back or manually provisioned deployment is safe. Apply it with `npm run db:migrate` before enabling the review routes.
