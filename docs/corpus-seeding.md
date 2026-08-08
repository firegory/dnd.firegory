# 2024 Corpus Seeding

`config/corpus-seed-2024.json` is the approved initial 2024 plan. It requires one operator-supplied collector snapshot for each supported type: class, species, background, feat, spell, glossary, creature, item, and equipment. The plan excludes older rules, adventures, narrative, media, partner/user/homebrew/premium/personal material, robots-disallowed material, and anything without explicit provenance, attribution, license basis, and operator approval.

No source document or real corpus is stored in this repository. `tests/fixtures/corpus-seed` contains only original synthetic test prose. A full seed requires external licensed snapshots, PostgreSQL 16 with migrations, Redis/publication spool, canonical NFS, and an operator evidence record; absence of any of these is an evidence gap, not a successful corpus load.

## Roles And Boundaries

| Operation | Authorization | Write boundary |
| --- | --- | --- |
| Collect and prepare external evidence | Trusted operator with source authorization | External snapshot store only |
| `corpus-seed validate` | Trusted operator | Atomic run manifest only; no DB/network access |
| `corpus-seed load` | Trusted operator executing as the worker writer with `DATABASE_URL` and `DND_DATA_ROOT` | Immutable canonical source evidence, source/file metadata, and import candidates only |
| Review/publish/rollback | Authenticated `admin` session and exact same-origin mutation | Publication spool/queue; never canonical NFS directly |
| Publication processing | Single worker identity | Sole canonical NFS writer |
| Reindex/embed | Trusted deployment operator | Derived PostgreSQL index only |
| Agent access | Scoped gateway token/session | Read-only; agents cannot seed, review, publish, reindex, or roll back |

Do not run two seed loaders for the same slot concurrently. PostgreSQL advisory locks serialize source setup, import leases serialize candidate work, and the publication worker remains the single writer.

## External Inputs

Collect each category separately so every slot has one complete category manifest. Network access is opt-in and collection itself never publishes:

```bash
SNAPSHOT_ROOT=/srv/dnd-firegory/seed-inputs/snapshots
npm run collect:next-dnd -- --output "$SNAPSHOT_ROOT/class" --category class --allow-network
npm run collect:next-dnd -- --output "$SNAPSHOT_ROOT/species" --category species --allow-network
npm run collect:next-dnd -- --output "$SNAPSHOT_ROOT/background" --category backgrounds --allow-network
npm run collect:next-dnd -- --output "$SNAPSHOT_ROOT/feat" --category feats --allow-network
npm run collect:next-dnd -- --output "$SNAPSHOT_ROOT/spell" --category spells --allow-network
npm run collect:next-dnd -- --output "$SNAPSHOT_ROOT/glossary" --category glossary --allow-network
npm run collect:next-dnd -- --output "$SNAPSHOT_ROOT/creature" --category bestiary --allow-network
npm run collect:next-dnd -- --output "$SNAPSHOT_ROOT/item" --category items --allow-network
npm run collect:next-dnd -- --output "$SNAPSHOT_ROOT/equipment" --category equipment --allow-network
```

Create `/srv/dnd-firegory/seed-inputs/inputs.json` with `schemaVersion: 1`, `planId: "approved-2024-corpus-v1"`, and exactly nine `slots`. Each slot has this shape; `manifestPath` is relative to `inputs.json` and every string must be a real operator value, not a placeholder:

```json
{
  "slotId": "spell",
  "snapshotRoot": "snapshots/spell",
  "manifestPath": "snapshots/spell/runs/<collector-manifest-digest>/manifest.json",
  "source": {
    "canonicalSourceId": "operator-approved-spells-2024",
    "title": "Operator-approved 2024 spell source",
    "language": "en",
    "category": "core_rules",
    "accessTier": "open",
    "publicationCode": "OPERATOR-CODE",
    "publisher": "Documented publisher",
    "revision": "documented-revision",
    "canonicalBookId": "operator-approved-spells",
    "originUrl": "https://next.dnd.su/spells/",
    "originId": "operator-evidence-id",
    "attribution": "Required attribution text",
    "license": "Operator-verified license or permission basis",
    "licenseApproval": {
      "approvedBy": "responsible-operator-id",
      "approvedAt": "2026-08-08T00:00:00.000Z",
      "evidenceReference": "external-ticket-or-record-id"
    }
  }
}
```

`snapshotRoot` is the collector `--output` directory containing `blobs`, `cache`, and `runs`; both paths are relative to the descriptor and the manifest must remain inside that root. The CLI rejects missing/extra slots and fields, absolute or escaping snapshot/blob paths, wrong category/type mappings, partial collector runs, stale parser versions, non-HTTPS or credential-bearing provenance, missing approvals, changed blob hashes/sizes, and unsupported source corpus fields. Evidence references are identifiers only; do not put credentials or private license documents in the descriptor.

## Validate And Load

Run the filesystem-only gate first. Every invocation, including a failed one after argument parsing, writes a mode-0600, fsynced temporary manifest and atomically renames it over the target. Output redacts credential-like keys, bearer values, and database URLs.

```bash
mkdir -p /srv/dnd-firegory/seed-runs
npm run corpus-seed -- validate \
  --inputs /srv/dnd-firegory/seed-inputs/inputs.json \
  --manifest /srv/dnd-firegory/seed-runs/validate.json
```

On a migrated fresh deployment, load candidates through the existing resumable import boundary:

```bash
export DATABASE_URL='postgres://<operator-provided-connection>'
export DND_DATA_ROOT='/srv/dnd-firegory/content'
export CORPUS_SEED_WRITER_ROLE='worker'
npm run db:migrate
npm run corpus-seed -- load \
  --inputs /srv/dnd-firegory/seed-inputs/inputs.json \
  --manifest /srv/dnd-firegory/seed-runs/load.json
```

`load` never calls review or publication APIs. It fails unless explicitly run in the worker writer role, validates the repository bootstrap, creates or verifies exact source metadata, atomically installs the hash-verified external manifest and matching `source.json` as immutable canonical evidence, creates/claims the existing durable import run, records occurrences/candidates, and completes the run. A crash after source installation is retryable because identical files are verified rather than replaced. A failed run is lease-reclaimable and immutable phases replay exactly. An identical successful input resolves the succeeded DB run and reports `operation: "noop"`; the output file is not used as authority.

A changed snapshot or approval record must use a new `canonicalSourceId` and `canonicalBookId` revision boundary. Existing canonical source records and file lists are immutable because published revisions embed and validate the complete source record. The loader fails rather than appending changed bytes to an already-published source.

Refresh counts at any time without mutation:

```bash
npm run corpus-seed -- status \
  --inputs /srv/dnd-firegory/seed-inputs/inputs.json \
  --manifest /srv/dnd-firegory/seed-runs/status.json
```

Each manifest has plan/input SHA-256 digests, start/finish/status, per-type discovered/imported/reviewed/published/indexed/failure counts, durable source/import IDs, operations, safe provenance, failures, and `autoPublished: false`.

## Review And Publish

Keep `npm run worker` running as the only process with read-write `DND_DATA_ROOT`. Use the admin UI at `/admin/compendium/imports/<run-id>`, or use the exact API flow below with a protected cookie jar obtained by an interactive admin login. Never place a session cookie in shell history or a manifest.

```bash
export APP_ORIGIN='https://dnd.example.invalid'
export RUN_ID='<importRunId-from-seed-manifest>'
export COOKIE_JAR='/secure/operator-admin-cookie.jar'

curl --fail-with-body --silent --show-error --cookie "$COOKIE_JAR" \
  "$APP_ORIGIN/api/admin/compendium/import-runs/$RUN_ID" > /secure/review-run.json

jq '{action:"approve",candidateIds:[.candidates[]|select(.publicationCapability=="publishable" and (.diffStatus=="new" or .diffStatus=="changed" or .diffStatus=="unchanged"))|.id],activeRevisionTokens:(reduce (.candidates[]|select(.publicationCapability=="publishable" and (.diffStatus=="new" or .diffStatus=="changed" or .diffStatus=="unchanged"))) as $candidate ({}; .[$candidate.id]=$candidate.activeRevisionToken))}' \
  /secure/review-run.json > /secure/review-action.json

curl --fail-with-body --silent --show-error --cookie "$COOKIE_JAR" \
  --header "Origin: $APP_ORIGIN" --header 'Content-Type: application/json' \
  --data-binary @/secure/review-action.json \
  "$APP_ORIGIN/api/admin/compendium/import-runs/$RUN_ID/actions"
```

The administrator must inspect provenance, diff, typed fields, citations, and payload capability before submitting. Do not bulk approve an empty selection. `requires_extraction`, invalid, or duplicate candidates fail closed and need supported repair/rejection; they are not auto-published. Wait for worker terminal outcomes, then run `corpus-seed status` again.

## Reindex And Embed

Publication activates canonical content before indexing. Validate canonical NFS without PostgreSQL, preview, synchronize, then optionally call the configured embedding provider:

```bash
npm run content-index -- validate --data-root /srv/dnd-firegory/content
npm run content-index -- incremental --dry-run --data-root /srv/dnd-firegory/content
npm run content-index -- incremental --data-root /srv/dnd-firegory/content
npm run content-index -- backfill-embeddings --batch-size 20
npm run corpus-seed -- status --inputs /srv/dnd-firegory/seed-inputs/inputs.json --manifest /srv/dnd-firegory/seed-runs/indexed.json
```

Embedding is derived and retryable. Provider absence/failure must not be represented as a completed full-corpus evidence gate.

## PDF Workflow

PDF maintenance is outside the snapshot seed plan but uses the same review/publication boundary. The file must be operator-authorized and remain outside git:

```bash
export DATABASE_URL='postgres://<operator-provided-connection>'
export REDIS_URL='redis://<operator-provided-connection>'
export STORAGE_ROOT='/srv/dnd-firegory/storage'
npm run ingest -- --pdf /secure/operator-input.pdf --title 'Operator-approved source' --category core_rules --edition 5.5e --language en --access open
npm run worker
```

Review the resulting extraction run with the authenticated commands above, publish only `publishable` candidates, then run validate/incremental/backfill commands. Roll back an erroneous publication through the admin entry UI using `unpublish`, its displayed active revision token, and an audit reason; never delete canonical files or edit manifests manually.

## Manual Workflow And Rollback

Manual content uses `/admin/compendium/entries`. An administrator selects an approved source/file, adds chunk/page quote evidence, creates a draft, reviews the preview, and queues publication with an actor reason and displayed canonical token. After worker completion, run canonical validation, incremental sync, and optional embedding backfill exactly as above.

For API-driven unpublication, first GET `/api/admin/compendium/entries/<versionId>`, read its displayed canonical active revision, then submit from the authenticated same-origin admin context:

```bash
export VERSION_ID='<version-uuid>'
export ACTIVE_REVISION='rev-<64-hex-from-fresh-admin-response>'
jq -n --arg active "$ACTIVE_REVISION" '{action:"unpublish",revisionId:null,expectedActiveRevisionId:$active,reason:"Audited rollback: <ticket>"}' > /secure/unpublish.json
curl --fail-with-body --silent --show-error --cookie "$COOKIE_JAR" \
  --header "Origin: $APP_ORIGIN" --header 'Content-Type: application/json' \
  --data-binary @/secure/unpublish.json \
  "$APP_ORIGIN/api/admin/compendium/entries/$VERSION_ID/publication"
```

Wait for the worker outcome, then run canonical validation and incremental sync. CAS rejection means the displayed state is stale: fetch it again and reassess; do not bypass the token. Database/NFS disaster recovery remains the backup procedure in `docs/backups.md`, not a seed operation.

## Evidence Gate

A production seed claim requires all of the following external evidence: successful validation/load/status manifests, nine approved source authorization records, admin review audit, worker publication completion, canonical validation, successful index sync, expected per-type counts, and embedding evidence if embeddings are claimed. This repository run cannot supply licensed inputs, production NFS, PostgreSQL, Redis, or provider access, so it must not be cited as proof that the full corpus was loaded.
