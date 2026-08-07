# Compendium Entry Editor

The administrator workspace at `/admin/compendium/entries` creates original entries and corrections through controlled fields for every compendium type. Content consists only of heading, paragraph, and list blocks. HTML-like markup and unknown payload fields are rejected by the server, and previews render React text nodes without raw HTML.

## Evidence and revisions

- A new entry selects one active source/file boundary. Edition and language come from that source.
- Evidence search returns at most 100 active-generation chunks from the selected file. A citation snapshots the exact chunk quote, generation, page, section, and Unicode code-point span. The existing authenticated PDF preview endpoint renders its page without exposing the source PDF path.
- At least one citation is required. Database insertion rechecks source/file/generation ownership and the exact quote span.
- Save creates a new `compendium_revisions` row, typed projection, and citation set in one transaction. Existing revision rows and children remain immutable.
- Every version has a separate `editor_head_revision_id`. Corrections carry the editor head seen when the form loaded; a version row lock compares and atomically advances it for both draft and published versions. Concurrent corrections from the same base cannot both save. A published version's `active_revision_id` changes only after worker publication succeeds.
- Cancel only restores client state and makes no mutation request.

## Publication boundary

Publish and unpublish requests require an actor reason and the exact canonical active revision token displayed by the editor. Before persisting an immutable publication review row, the server rejects deleted or mismatched source/file boundaries, pageless citations, inactive evidence generations, and invalid canonical revisions. Canonical source projection uses the shared metadata projector and includes every nondeleted file plus access, ownership, origin, attribution, publication, and license metadata.

The server then submits a guarded v2 publication command and never writes canonical NFS files directly. Only ambiguity after a durable command reaches enqueue is returned as `pending`; source, schema, canonical, and repository-contract validation errors fail the request synchronously. A pending submission can be retried with the same idempotency key, while a different open command is rejected.

The #76 publication worker processes the same spool and queue. Its canonical fence performs the authoritative active-revision CAS. A stale command fails without replacing either immutable database revision. Only a successful worker outcome activates the database revision and marks the command complete; failed outcomes retain their error. Worker audit events use `publication-worker` and retain the initiating administrator in details.

Unpublish changes canonical repository state only after worker success. The relational revision history remains intact and inspectable.

## API

- `GET /api/admin/compendium/entries`: entry summaries.
- `POST /api/admin/compendium/entries`: create an original draft.
- `GET /api/admin/compendium/entries/evidence?sourceId=...&fileId=...&q=...`: source boundaries and citation chunks.
- `GET /api/admin/compendium/entries/{versionId}`: revisions, publication attempts, and audit history.
- `POST /api/admin/compendium/entries/{versionId}`: save an immutable correction.
- `POST /api/admin/compendium/entries/{versionId}/publication`: queue publish or unpublish.

All endpoints require an administrator session. Mutations additionally require an exact same-origin `Origin` header.

## Migration 0014

`0014_compendium_entry_editor.sql` adds the editor head, revision author/reason/base metadata, immutable publication commands, and append-only audit events. It backfills existing editor heads from active revisions. Composite foreign keys ensure revision references belong to the same version, and corrections with `based_on_revision_id` require a nonblank actor and reason. Apply it with `npm run db:migrate` before enabling the routes.
