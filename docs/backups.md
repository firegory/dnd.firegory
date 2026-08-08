# Backup, Restore, and Disaster Recovery

This runbook covers the production stack in `compose.production.yml`. Run every
command from the repository root on the Docker host unless a step explicitly
says otherwise. Development volume names from `docker-compose.yml` are not
valid production recovery targets.

## Recovery contract

| Data | Production location | Authority | Recovery action |
| --- | --- | --- | --- |
| Canonical compendium | Host NFSv4 path `DND_DATA_HOST_PATH` (normally `/mnt/dnd-firegory`), bind-mounted at `DND_DATA_ROOT` (normally `/app/content-repository`) | Canonical | Snapshot/archive and restore first; verify every checksum before indexing |
| Users and sessions | PostgreSQL tables `users` and `sessions` in the `postgres_data` volume | Critical, not rebuildable | Restore the complete logical PostgreSQL dump |
| Audit and operational history | PostgreSQL, including `search_events`, `rag_events`, `compendium_import_audit`, `compendium_import_review_audit`, and `compendium_editor_audit` | Critical, not rebuildable | Restore the complete logical PostgreSQL dump |
| NFS-managed search index | PostgreSQL NFS ownership/index tables and their managed `sources`, `files`, `ingestion_generations`, `documents`, `pages`, and `chunks` | Rebuildable from canonical NFS | Run a clean content-index synchronization after restore |
| Embeddings | `chunks.embedding` and `chunks.embedding_model` | Rebuildable derived data | Backfill after the structured index is healthy |
| Redis queue/cache | `redis_data` volume | Noncanonical | Start empty; reconcile interrupted work rather than restoring Redis |
| Upload/publication spool | `upload_spool` volume at `/app/storage` | Noncanonical operational staging | Start empty in a disaster drill; retry unfinished uploads/publications from their authoritative inputs |
| App, worker, gateway, migrate, Redis container filesystems | Images plus read-only container layers | Replaceable | Rebuild/recreate from the tested commit; never back up a container filesystem |

The PostgreSQL dump is intentionally complete to preserve foreign-key
consistency and any manually managed content. Its NFS-managed index rows and
embeddings are convenient copies, not backup authorities. `content-index clean`
reconciles only rows owned by NFS synchronization and does not delete users,
sessions, audit history, or unmanaged content. See
[NFS Content Index Synchronization](content-index-sync.md) for the exact rebuild
boundary.

The local spool can contain an upload that has not reached canonical NFS yet.
That work is outside the canonical recovery guarantee. Monitor and retry it from
the original upload or publication request after recovery; do not copy an
unknown in-flight spool into a clean environment.

## Measurable objectives

These are operating assumptions, not claims about an unmeasured environment:

| Objective | Target | Assumptions and measurement |
| --- | --- | --- |
| Backup interval | Start one NFS/PostgreSQL backup set every 60 minutes | Alert if a set is not checksummed in the separate failure domain within 60 minutes of its source snapshot |
| Site-loss RPO | At most 2 hours | 60-minute start interval plus at most 60 minutes to archive, verify, and replicate the set to a separate failure domain |
| Service RTO | At most 4 hours from declaration | At most 100 GiB canonical NFS and 20 GiB compressed PostgreSQL, sustained restore throughput of at least 100 MiB/s, credentials/secrets already available, and a replacement host/NFS export ready |
| Vector-search recovery | At most 24 hours after structured service recovery | Embedding provider is available at the configured rate; keyword search is restored inside the 4-hour service RTO |

The four-hour drill budget is: 15 minutes to declare and select a backup, 90
minutes for NFS, 45 minutes for PostgreSQL, 60 minutes for validation/indexing,
and 30 minutes for startup and acceptance checks. Record actual UTC start/end
times, byte counts, and observed throughput in every quarterly drill. If data
size or measured throughput makes any stage exceed its budget, increase
capacity or revise and approve the objective before relying on it.

## Host and identity prerequisites

Production Compose does not mount or provision NFS. Infrastructure must mount
the NFSv4 export on the host before Compose starts. Server addresses, mount
options, Kerberos material, keytabs, and all other NFS access material belong in
the host/infrastructure secret manager, never in this repository, `.env`, a
backup archive, or generated Compose configuration.

Set only non-secret paths and numeric identities in `.env`:

```bash
DND_DATA_HOST_PATH=/mnt/dnd-firegory
DND_DATA_ROOT=/app/content-repository
APP_UID=10001
APP_GID=10001
GATEWAY_UID=10001
GATEWAY_GID=10001
```

App and worker must use the same `APP_UID:APP_GID`, default `10001:10001`.
Canonical files restored by root must retain their archived numeric ownership.
The app and gateway mount NFS read-only; only the worker mounts it read-write.
Root squashing is expected. Before backup or restore, verify the active mount and
the Compose contract:

```bash
set -euo pipefail
set -a
. ./.env
set +a
./scripts/production-nfs-preflight.sh
npm run production:config
case "${APP_UID:-10001}" in ''|*[!0-9]*) echo "APP_UID must be numeric" >&2; exit 1;; esac
case "${APP_GID:-10001}" in ''|*[!0-9]*) echo "APP_GID must be numeric" >&2; exit 1;; esac
```

The identity checks reject nonnumeric host mappings; the static validator
enforces that app and worker use the same configured values. The NFS export must
preserve numeric ownership, atomic same-filesystem rename, hard links, fsync,
and NFS close-to-open consistency as described in
`docs/deployment.md` and `content-repository/README.md`.

## Create a backup set

The reference procedure briefly quiesces only the worker while reading NFS.
App and gateway remain available; publication requests may queue in the local
spool until the worker restarts. A provider-side atomic snapshot may replace
that quiesced read only when it snapshots the complete export on one filesystem.
Run the documented commands from an isolated backup host where that read-only
snapshot is mounted at its configured `DND_DATA_HOST_PATH`, so the Compose bind
and `NFS_SOURCE` resolve the same tree. The provider-specific snapshot command
and access material must remain in the infrastructure runbook.

### 1. Select paths and prove NFS

`BACKUP_ROOT` must be durable storage outside the canonical NFS export. The
off-host replication mechanism is deployment-specific and must not copy the
production secret directory.

```bash
set -euo pipefail
umask 077
set -a
. ./.env
set +a
export BACKUP_ROOT=/srv/backups/dnd-firegory
export BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export BACKUP_DIR="$BACKUP_ROOT/$BACKUP_ID"
export NFS_SOURCE="$DND_DATA_HOST_PATH"
install -d -m 0700 "$BACKUP_DIR"
./scripts/production-nfs-preflight.sh
npm run production:config
```

### 2. Archive a stable canonical tree

Run this block in one shell. Its trap restarts the worker if validation,
checksum generation, or archiving fails.

```bash
set -euo pipefail
compose=(docker compose -f compose.production.yml)
"${compose[@]}" stop worker
trap 'docker compose -f compose.production.yml start worker' EXIT

"${compose[@]}" run --rm --no-deps worker \
  node --experimental-strip-types scripts/content-index.mts validate

(
  cd "$NFS_SOURCE"
  find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
) > "$BACKUP_DIR/nfs-files.sha256"

tar --create --gzip --file "$BACKUP_DIR/nfs.tar.gz" \
  --numeric-owner --acls --xattrs --one-file-system \
  --directory "$NFS_SOURCE" .

"${compose[@]}" start worker
trap - EXIT
```

`content-index validate` resolves all activation deltas and validates canonical
schemas, revision identities, and declared source-file SHA-256 hashes without
connecting to PostgreSQL. The independent `nfs-files.sha256` manifest also
covers repository files not referenced by the active canonical manifest.

### 3. Dump all PostgreSQL state

`pg_dump` takes a transactionally consistent database snapshot while the app
continues to run. The custom archive includes all table data, including users,
password hashes, sessions, audit history, unmanaged content, NFS-derived rows,
and embeddings. It does not include Compose's database role password; restore
uses the role initialized from the target environment's existing secret.

```bash
set -euo pipefail
compose=(docker compose -f compose.production.yml)
"${compose[@]}" exec -T postgres pg_dump \
  --username "${POSTGRES_USER:-dnd}" \
  --dbname "${POSTGRES_DB:-dnd_firegory}" \
  --format custom --no-owner --no-acl \
  > "$BACKUP_DIR/postgres.dump"

"${compose[@]}" exec -T postgres pg_restore --list \
  < "$BACKUP_DIR/postgres.dump" > "$BACKUP_DIR/postgres.toc"

for table in users sessions search_events rag_events \
  compendium_import_audit compendium_import_review_audit compendium_editor_audit; do
  grep -Eq "TABLE DATA public ${table} " "$BACKUP_DIR/postgres.toc"
done
```

The table-of-contents checks fail the backup if any explicitly critical table
is absent. A complete logical dump is required; do not replace it with a
table-filtered dump.

### 4. Seal, verify, and replicate

```bash
set -euo pipefail
(
  cd "$BACKUP_DIR"
  sha256sum nfs.tar.gz nfs-files.sha256 postgres.dump postgres.toc \
    > backup-set.sha256
  sha256sum --check backup-set.sha256
)
printf '%s\n' "$BACKUP_ID" > "$BACKUP_DIR/COMPLETE"
```

Replicate the complete directory to a separate failure domain within 60
minutes of the source snapshot, then run `sha256sum --check backup-set.sha256`
there. A set without
`COMPLETE`, a successful archive checksum check, and all critical PostgreSQL TOC
entries is not a backup. Retain 24 hourly sets, 14 daily sets, and 12 monthly
sets unless a stricter policy applies. Test restoration, not archive age alone.

## Empty-environment restore drill

Run quarterly on an isolated host or isolated Compose project with a newly
created, empty NFS export and no pre-existing Docker volumes. Never run the
destructive cleanup commands below against the production Compose project.
Prepare the normal production secret files outside git as documented in
`docs/deployment.md`; do not copy NFS access material or old application secrets
out of their secret managers.

### 1. Prove isolation and verify the backup before extraction

Set `.env` so `DND_DATA_HOST_PATH` is the empty drill NFS mount. Use a unique
project name so production volumes cannot be selected accidentally.

```bash
set -euo pipefail
umask 077
set -a
. ./.env
set +a
export BACKUP_DIR=/srv/backups/dnd-firegory/20260808T000000Z
export COMPOSE_PROJECT_NAME=dnd94restore
test -f "$BACKUP_DIR/COMPLETE"
(
  cd "$BACKUP_DIR"
  sha256sum --check backup-set.sha256
)
./scripts/production-nfs-preflight.sh
test -z "$(find "$DND_DATA_HOST_PATH" -mindepth 1 -maxdepth 1 -print -quit)"
test -z "$(docker compose -f compose.production.yml ps --all --quiet)"
test -z "$(docker volume ls --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")"
```

If the final isolation check finds containers, choose a new project name. Do not
delete unknown volumes to make the check pass.

### 2. Restore NFS with numeric ownership

```bash
set -euo pipefail
sudo tar --extract --gzip --file "$BACKUP_DIR/nfs.tar.gz" \
  --same-owner --numeric-owner --acls --xattrs \
  --directory "$DND_DATA_HOST_PATH"

(
  cd "$DND_DATA_HOST_PATH"
  sha256sum --check "$BACKUP_DIR/nfs-files.sha256"
)
```

Do not continue on any missing or mismatched checksum.
The worker needs numeric `APP_UID:APP_GID` write access after extraction; do not
recursively change ownership as a workaround because canonical provenance may
contain intentionally different owners. Use the host NFS ACL/identity mapping
and `./scripts/production-permissions-smoke.sh` after startup to prove access.

### 3. Restore PostgreSQL into a fresh volume

Start only PostgreSQL. This creates a new project-scoped `postgres_data` volume
and initializes pgvector. Restore before running current migrations, then let the
repository's migration service apply only migrations newer than the dump.

```bash
set -euo pipefail
compose=(docker compose -f compose.production.yml)
"${compose[@]}" up --detach --wait postgres
"${compose[@]}" exec -T postgres pg_restore \
  --username "${POSTGRES_USER:-dnd}" \
  --dbname "${POSTGRES_DB:-dnd_firegory}" \
  --no-owner --no-acl --exit-on-error \
  < "$BACKUP_DIR/postgres.dump"
"${compose[@]}" run --rm migrate
```

Verify the irreplaceable tables before rebuilding derived rows:

```bash
docker compose -f compose.production.yml exec -T postgres psql \
  --username "${POSTGRES_USER:-dnd}" \
  --dbname "${POSTGRES_DB:-dnd_firegory}" \
  --set ON_ERROR_STOP=1 \
  --command "SELECT 'users' AS table_name, count(*) FROM users
             UNION ALL SELECT 'sessions', count(*) FROM sessions
             UNION ALL SELECT 'search_events', count(*) FROM search_events
             UNION ALL SELECT 'rag_events', count(*) FROM rag_events
             UNION ALL SELECT 'compendium_import_audit', count(*) FROM compendium_import_audit
             UNION ALL SELECT 'compendium_import_review_audit', count(*) FROM compendium_import_review_audit
             UNION ALL SELECT 'compendium_editor_audit', count(*) FROM compendium_editor_audit
             ORDER BY table_name"
```

### 4. Verify canonical content again, then rebuild the index

The first command is the mandatory checksum gate. The second performs the
application-level schema/hash validation and never connects to PostgreSQL. Only
after both pass may the clean dry run and clean rebuild access the database.

```bash
set -euo pipefail
compose=(docker compose -f compose.production.yml)
(
  cd "$DND_DATA_HOST_PATH"
  sha256sum --check "$BACKUP_DIR/nfs-files.sha256"
)
"${compose[@]}" run --rm --no-deps worker \
  node --experimental-strip-types scripts/content-index.mts validate
"${compose[@]}" run --rm --no-deps worker \
  node --experimental-strip-types scripts/content-index.mts clean --dry-run
"${compose[@]}" run --rm --no-deps worker \
  node --experimental-strip-types scripts/content-index.mts clean
```

Save the JSON output. The clean run deterministically reconciles every active
NFS-managed entry in one activation transaction. It leaves critical and
unmanaged PostgreSQL state untouched.

### 5. Start with empty Redis and prove service recovery

Do not restore `redis_data`. Compose creates an empty project-scoped volume.
Start the stack through the mandatory NFS preflight and confirm migration and
health status:

```bash
./scripts/production-up.sh --detach --build
docker compose -f compose.production.yml ps
docker compose -f compose.production.yml ps --all migrate
./scripts/production-permissions-smoke.sh
```

Verify login, admin access, canonical browsing, keyword search, and audit-history
visibility. The permission smoke proves app/gateway read-only and worker
read-write access under the configured numeric identities. Treat queue jobs that
were `queued` or `processing` at backup time as interrupted: inspect them in the
admin UI and retry from their authoritative input. Never infer successful
publication from restored Redis state.

### 6. Backfill embeddings independently

Structured and keyword search must be healthy first. The worker image contains
the supported command, which selects only active NFS-managed chunks with null
embeddings and uses the configured ingestion embedding provider:

```bash
docker compose -f compose.production.yml run --rm --no-deps worker \
  node --experimental-strip-types scripts/content-index.mts \
  backfill-embeddings --batch-size 20
```

Confirm that no active NFS-managed chunks remain unembedded:

```bash
docker compose -f compose.production.yml exec -T postgres psql \
  --username "${POSTGRES_USER:-dnd}" \
  --dbname "${POSTGRES_DB:-dnd_firegory}" \
  --set ON_ERROR_STOP=1 --tuples-only \
  --command "SELECT count(*)
             FROM chunks c
             JOIN files f ON f.id=c.file_id AND f.active_generation_id=c.generation_id
             JOIN nfs_index_managed_files mf ON mf.file_id=c.file_id
             WHERE c.embedding IS NULL"
```

Embedding completion is outside the four-hour service RTO. Provider failure
must not delay keyword-search recovery.

### 7. Prove containers are replaceable

Run the existing destructive smoke only in this isolated drill project. It
writes temporary canonical, spool, PostgreSQL, and Redis markers, force-recreates
app, worker, PostgreSQL, and Redis, verifies persistence, and removes its file
markers. Then recreate the read-only gateway and confirm all healthchecks:

```bash
./scripts/production-replacement-smoke.sh
docker compose -f compose.production.yml up \
  --detach --no-deps --force-recreate gateway
docker compose -f compose.production.yml up --detach --wait
docker compose -f compose.production.yml ps
```

Passing proves data survives replacement of application containers because it
lives on NFS or explicit volumes, not in container layers. Record the image IDs,
container IDs before/after, command output, checks, and elapsed RTO. Tear down
only the isolated drill after evidence is retained:

```bash
docker compose -f compose.production.yml down --volumes --remove-orphans
```

## Failure modes and rollback

| Failure | Safe response | Rollback |
| --- | --- | --- |
| NFS mount missing, local, stale, read-only to worker, or wrong UID/GID | Stop before extraction/indexing. Fix the host mount or numeric ACL mapping and rerun preflight, archive checksum, file checksums, and canonical validation. | Keep the failed export isolated. Remount the last known-good export/snapshot or empty the isolated drill export and re-extract the last verified archive. Never use recursive `chown` to conceal identity drift. |
| NFS archive or restored-file checksum mismatch | Quarantine the set; do not run `clean` or start application services. Try the separately replicated copy and compare its `backup-set.sha256`. | Return to the untouched prior NFS snapshot/export. If no verified set exists inside RPO, declare the RPO miss rather than indexing corrupt content. |
| PostgreSQL dump/restore or pgvector failure | Keep app, worker, and gateway stopped. Save logs and verify archive checksum/TOC, target PostgreSQL 16 image, secret-selected database/user, and free space. | Discard only the new isolated `postgres_data` volume and retry into another fresh project. In production, switch back to the untouched old database volume/host; never `pg_restore --clean` over the sole recoverable database. |
| Migration failure | The migration script rolls back the failing migration transaction. Keep schema consumers stopped and inspect `migrate` logs. | Restore another fresh database from the dump and deploy the last compatible tested commit. Do not edit `schema_migrations` manually. |
| Redis loss, corrupt AOF, or incompatible Redis image | Treat Redis as empty noncanonical state. Recreate only `redis_data`, start Redis, then reconcile interrupted jobs/publications from PostgreSQL and authoritative input. | No data rollback is required. If a new image is faulty, recreate Redis with the prior pinned image; do not make Redis a recovery authority. |
| Index validation/staging/activation failure | Keep restored PostgreSQL and NFS intact. Validation is read-only; staging is invisible; activation is transactional and rolls back on failure. Correct canonical corruption, lease contention, or configuration, rerun `validate`, then `clean --dry-run`. | If a completed new index is behaviorally wrong, stop schema consumers and restore PostgreSQL into a fresh volume from the pre-rebuild dump, then run the previous tested projector. Never roll back canonical NFS to preserve a derived index. |
| Embedding provider, model, rate-limit, or dimension failure | Leave keyword search online. The supported backfill updates null embeddings incrementally and can be rerun after provider/configuration repair. | For a confirmed bad NFS embedding batch, stop vector traffic, clear only affected NFS-managed `embedding` and `embedding_model` values in a reviewed transaction, then rerun the supported backfill. Do not delete chunks or canonical files. |
| Replacement app/worker/gateway image fails healthcheck | Keep NFS and all named volumes attached and inspect service logs. Containers contain no authoritative state. | Recreate the service from the previous tested commit/image. Do not use `down --volumes`; container rollback never requires data-volume rollback. |

For embedding rollback, first run the equivalent `SELECT count(*)` using the
same joins and an `embedding_model` predicate that identifies the bad model.
Have a second operator review the scope before changing rows. The transaction
shape is:

```sql
BEGIN;
UPDATE chunks c
SET embedding = NULL, embedding_model = NULL
FROM files f, nfs_index_managed_files mf
WHERE f.id = c.file_id
  AND f.active_generation_id = c.generation_id
  AND mf.file_id = c.file_id
  AND c.embedding_model = '<confirmed-bad-model>';
-- Verify the affected row count before choosing COMMIT; otherwise ROLLBACK.
ROLLBACK;
```

`ROLLBACK` is intentional in the template. Replace it with `COMMIT` only after
the reviewed count matches the incident scope.

## Drill evidence

A drill passes only when all of the following are recorded:

1. Backup set ID, source commit, UTC timestamps, sizes, checksum output, and separate-failure-domain location.
2. Proof that the target NFS export and Compose project had no prior data.
3. Successful archive checksum, restored-file checksum, and `content-index validate` before any index mutation.
4. PostgreSQL TOC coverage and post-restore counts for users, sessions, and every listed audit table.
5. Successful migration, clean dry run, clean index rebuild, login, canonical browse, and keyword search.
6. Embedding completion or a recorded degraded-mode backfill ETA within 24 hours.
7. Replacement-smoke output and changed container IDs with unchanged canonical, PostgreSQL, spool, and Redis marker data.
8. Measured RPO and stage-by-stage RTO against the objectives above, including every exception or manual intervention.

Archive this evidence outside the recovered stack. A static documentation test
validates command names, paths, identities, critical table coverage, ordering,
and NFS secret exclusions, but only a live drill can validate storage snapshots,
throughput, provider access, restore permissions, and application behavior.
