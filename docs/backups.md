# Backup, Restore, and Disaster Recovery

This runbook covers `compose.production.yml`. Run commands from the repository
root. Production backup commands name the production Compose project explicitly.
Every restore-drill Compose command goes through `scripts/dr-compose.sh` and
names a guarded DR-only project explicitly; none may rely on
`COMPOSE_PROJECT_NAME` or Compose's directory-derived default.
The wrapper resolves the repository, Compose file, and `.env` to canonical
absolute paths, clears all relevant `COMPOSE_*` ambient overrides, and exposes
only named operations. It never forwards Compose flags, service definitions,
commands, volumes, mounts, build contexts, profiles, or config paths supplied by
an operator.

## Recovery contract

| Data | Production location | Authority | Recovery action |
| --- | --- | --- | --- |
| Canonical compendium | Host NFSv4 `DND_DATA_HOST_PATH` (normally `/mnt/dnd-firegory`), mounted in containers at `DND_DATA_ROOT` (normally `/app/content-repository`) | Canonical | Restore an atomic provider snapshot or verified encrypted archive before indexing |
| Users and sessions | PostgreSQL `users` and `sessions` in `postgres_data` | Critical, not rebuildable | Restore the complete logical dump and compare snapshot fingerprints |
| Audit history | PostgreSQL `search_events`, `rag_events`, `compendium_import_audit`, `compendium_import_review_audit`, and `compendium_editor_audit` | Critical, not rebuildable | Restore the complete logical dump and compare snapshot fingerprints |
| Ingestion jobs | PostgreSQL `ingestion_jobs` | Critical operational history | Preserve history, then transactionally terminalize restored active jobs because Redis/spool are empty |
| NFS-managed search index | NFS ownership/index tables and managed `sources`, `files`, `ingestion_generations`, `documents`, `pages`, and `chunks` | Rebuildable | Run validated clean synchronization and record cardinality |
| Embeddings | `chunks.embedding` and `chunks.embedding_model` | Rebuildable | Backfill after structured and keyword search recover |
| Redis | `redis_data` | Noncanonical | Start empty; never restore as an authority |
| Upload/publication spool | `upload_spool` at `/app/storage` | Noncanonical staging | Start empty; interrupted uploads require re-upload from authoritative input |
| App, worker, gateway, migrate, and Redis containers | Read-only image/container layers | Replaceable | Recreate from the recorded source commit; never back up container filesystems |

The complete PostgreSQL dump preserves foreign keys, users, sessions, audit
history, ingestion history, and unmanaged rows. Its NFS-derived rows and
embeddings are copies, not authorities. `content-index clean` reconciles only
NFS-managed rows and does not remove critical or unmanaged state.

## Objectives and assumptions

| Objective | Target | Measured evidence |
| --- | --- | --- |
| Backup start interval | 60 minutes | Provider snapshot schedule |
| Site-loss RPO | At most 2 hours | 60-minute interval plus at most 60 minutes from `sourceSnapshotTime` to `replicationCompletedAt` |
| Structured-service RTO | At most 4 hours | `servicesAccepted - drillStarted`, with NFS, PostgreSQL, index, and acceptance stage timestamps |
| Vector-search recovery | At most 24 hours after structured recovery | Embedding-null cardinality and backfill completion time |

These targets assume at most 100 GiB NFS, 20 GiB compressed PostgreSQL, at
least 100 MiB/s sustained restore throughput, an already provisioned replacement
host/export, current application secrets in the secret manager, and a tested
embedding provider. The backup metadata and sealed drill summary calculate
actual pipeline age and RTO. If the measured values exceed the targets, record
an objective miss; do not rewrite timestamps or claim an unmeasured RPO/RTO.

## Backup security

PostgreSQL dumps contain password hashes, session-token hashes, personal data,
and audit queries. NFS archives may contain licensed content. Therefore:

- `age` encrypts every data artifact before it leaves a sized tmpfs. Plaintext
  backup artifacts must never touch persistent host disks.
- The backup writer receives only an `age` public recipient. Its corresponding
  private identity is held by a separate recovery role in a hardware-backed or
  equivalent secret manager; app, worker, and routine backup roles cannot read it.
- Replication must use mutually authenticated TLS 1.2+ or SSH/SFTP with pinned
  host identity in addition to artifact encryption. Public object access and
  plaintext transfer are forbidden.
- Backup storage and recovery-key access use separate least-privilege accounts
  with audited break-glass grants. Rotate recipients at least annually and after
  any access incident. Retain old private identities only until all backups
  encrypted to them expire.
- A separate replica-sealing role holds the minisign backup-signing private key.
  The backup writer and age recovery role cannot sign sets; restore hosts receive
  only the minisign public key. Drill evidence uses another signing key so backup
  and evidence compromise do not share a trust root.
- Retain 24 hourly, 14 daily, and 12 monthly sealed sets unless policy is
  stricter. Secure expiry deletes every replica/version and then retires the
  corresponding recovery key when no retained set needs it.
- NFS endpoints, mount credentials, Kerberos material, database passwords, age
  private identities, and application secrets remain outside git and evidence.

Backup and evidence destinations must themselves use encrypted storage. File
modes are defense in depth, not a substitute for storage encryption.

## Create a stable backup set

### 1. Create an atomic provider snapshot

Use the NFS provider/control plane to atomically snapshot the complete canonical
export on one filesystem. Record its immutable provider ID and UTC creation
time. Mount that snapshot as a separate **read-only** NFS mount, for example
`/mnt/dnd-firegory-snapshots/<snapshot-id>`. Never archive the live writable
mount, even with the worker stopped: a backup made from live client reads is not
accepted because activation deltas and revision files can form a torn set.

Provider commands, endpoints, and credentials belong in infrastructure
automation, not this repository. The snapshot must preserve atomic rename,
hard-link, fsync, close-to-open, and same-filesystem semantics documented in
`content-repository/README.md`.

### 2. Generate encrypted artifacts and snapshot fingerprints

Create an empty encrypted destination and provide a sufficiently large tmpfs.
Install `age`, `minisign`, and the host `acl`/`attr` tools (`getfacl` and
`getfattr`) before scheduling backups.
The script requires an explicit production project, proves the snapshot mount is
NFS and `ro`, validates canonical schemas/hashes, archives it, extracts the
archive into tmpfs, verifies every archived regular file against the manifest,
and only then encrypts it. It exports one PostgreSQL repeatable-read snapshot and
uses that exact snapshot for both `pg_dump` and critical row
counts/fingerprints.

```bash
set -euo pipefail
export DND_BACKUP_PLAINTEXT_TMPDIR=/run/dnd-backup-tmpfs
install -d -m 0700 /srv/encrypted-backups/dnd-firegory/20260808T000000Z
./scripts/create-backup-set.sh \
  --project-name dnd-firegory-production \
  --snapshot-path /mnt/dnd-firegory-snapshots/snap-20260808T000000Z \
  --snapshot-id snap-20260808T000000Z \
  --snapshot-time 2026-08-08T00:00:00Z \
  --backup-dir /srv/encrypted-backups/dnd-firegory/20260808T000000Z \
  --age-recipient age1REPLACE_WITH_BACKUP_PUBLIC_RECIPIENT
```

The script emits encrypted `nfs.tar.gz`, file manifest, NFS validation output,
PostgreSQL dump/TOC, complete tree manifest, and `source-fingerprints.csv`, plus non-secret
`backup-metadata.json` and ciphertext checksums. It deliberately does not create
`COMPLETE.json`; local creation is not offsite durability.

The fingerprint SQL covers `users`, `sessions`, all listed audit tables, and
`ingestion_jobs`. It canonicalizes each row through PostgreSQL JSONB, then emits
a row count, two independent `bit_xor(hashtextextended(...))` aggregates, and a
third numeric sum aggregate. PostgreSQL 16 computes these in bounded aggregate
state without an unbounded `string_agg`. The signed, exact CSV comparison is
stronger than TOC presence and is tied to the dump's exported snapshot.

### 3. Replicate, verify, and seal

Replicate the directory over the approved encrypted transport to a separate
failure domain within 60 minutes of `sourceSnapshotTime`. On that replica:

```bash
export DND_BACKUP_SIGNING_SECRET_KEY_FILE=/run/secrets/dnd-backup-sealing-minisign.key
export DND_BACKUP_SIGNING_PUBLIC_KEY_FILE=/etc/dnd-firegory/backup-minisign.pub
./scripts/seal-backup-replica.sh \
  --backup-dir /srv/replicated-encrypted-backups/dnd-firegory/20260808T000000Z
./scripts/verify-backup-set.sh \
  --backup-dir /srv/replicated-encrypted-backups/dnd-firegory/20260808T000000Z
```

Before sealing, chronology validation requires strict UTC timestamps ordered as
source snapshot, backup start, NFS verification start/finish, PostgreSQL snapshot
export, dump start/finish, backup generation, and replication completion. Every
timestamp is checked against current time with a five-minute clock-skew ceiling.
Invalid, reversed, missing, or unreasonably future metadata cannot produce
`COMPLETE.json`.

Sealing rechecks every ciphertext checksum, signs the checksum manifest and
`COMPLETE.json`, and binds metadata/checksum/signature hashes,
source snapshot time, and `replicationCompletedAt` in mode-0400
`COMPLETE.json`. A set without a valid `COMPLETE.json` is incomplete and cannot
be selected for restore.

## Empty-environment restore drill

Use an isolated host and newly provisioned empty NFS export. The DR authorization
has three independent requirements:

1. An explicit project matching `dnd94-dr-*`.
2. The exact `DND_DR_OPT_IN` phrase shown below.
3. A mode-0600 marker outside NFS that binds that project to the canonicalized
   target path and was created only after the guard proved the target empty.

`dr-compose`, permission smoke, replacement smoke, evidence sealing, and
teardown each re-run the guard. A stale ambient variable cannot redirect them.
The guard refuses missing/mismatched markers, non-empty initialization,
non-NFS targets, nested project overrides, and production-style project names.

### 1. Authorize the empty target and start evidence

Set `.env` `DND_DATA_HOST_PATH` to the isolated DR export, never the production
path. `DND_DR_PRODUCTION_DATA_PATH` records the protected production mount and
is required; the guard rejects equality. The marker also hashes the current NFS
mount source/root/type/options, so swapping the mount at the same path invalidates
every guarded command.

```bash
set -euo pipefail
set -a
. ./.env
set +a
export DR_PROJECT=dnd94-dr-20260808
export DND_DR_OPT_IN=I_UNDERSTAND_DND_FIREGORY_DR_IS_DESTRUCTIVE
export DND_DR_EMPTY_TARGET_MARKER="/var/lib/dnd-firegory-dr/$DR_PROJECT.marker"
export DND_DR_PRODUCTION_DATA_PATH=/mnt/dnd-firegory
export DND_BACKUP_SIGNING_PUBLIC_KEY_FILE=/etc/dnd-firegory/backup-minisign.pub
export BACKUP_DIR=/srv/replicated-encrypted-backups/dnd-firegory/20260808T000000Z
export DR_PLAINTEXT="/run/dnd-dr-tmpfs/$DR_PROJECT"
export DND_DR_EVIDENCE_ROOT=/srv/encrypted-dr-evidence
export DR_EVIDENCE="$DND_DR_EVIDENCE_ROOT/$DR_PROJECT"
install -d -m 0700 "$DR_PLAINTEXT" "$DR_EVIDENCE"
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" \
  "$(dirname "$DND_DR_EMPTY_TARGET_MARKER")"
./scripts/dr-target-guard.sh initialize --project-name "$DR_PROJECT"
./scripts/verify-backup-set.sh --backup-dir "$BACKUP_DIR"
export BACKUP_COMMIT="$(node --input-type=module --eval \
  'import { readFileSync } from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1], "utf8")).sourceCommit)' \
  "$BACKUP_DIR/backup-metadata.json")"
test "$(git rev-parse HEAD)" = "$BACKUP_COMMIT"
printf 'event,timestamp\ndrill_started,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$DR_EVIDENCE/timeline.csv"
cp "$BACKUP_DIR/backup-metadata.json" "$BACKUP_DIR/COMPLETE.json" "$DR_EVIDENCE/"
```

`DR_PLAINTEXT` must be a sized tmpfs and `DR_EVIDENCE` must be encrypted
storage. Fetch the age private identity into a short-lived root-readable file in
tmpfs through the recovery-role secret manager; never place it in `.env` or
shell history.

The marker directory is mode 0700 and explicitly assigned to the invoking
non-root drill operator; the guard verifies that owner before creating or
reading a marker.

Decrypt only the artifacts needed for restore:

```bash
set -euo pipefail
export AGE_IDENTITY_FILE="$DR_PLAINTEXT/recovery-identity"
test "$(findmnt --noheadings --raw --output FSTYPE --target "$DR_PLAINTEXT")" = tmpfs
for artifact in nfs.tar.gz nfs-files.sha256 nfs-tree.jsonl nfs-access-model.json postgres.dump source-fingerprints.csv; do
  age --decrypt --identity "$AGE_IDENTITY_FILE" \
    --output "$DR_PLAINTEXT/$artifact" "$BACKUP_DIR/$artifact.age"
done
cp "$DR_PLAINTEXT/source-fingerprints.csv" "$DR_EVIDENCE/source-fingerprints.csv"
```

### 2. Restore canonical NFS without client-root ownership

`root_squash` is expected. Client root cannot restore numeric ownership and this
runbook never asks it to. Choose one supported method:

- Preferred: the provider/server restores or clones the recorded immutable
  snapshot into the authorized empty DR export, preserving server-side metadata.
- Controlled archive fallback: infrastructure confirms the export maps numeric
  `APP_UID:APP_GID` to the worker service identity, then extraction runs as that
  identity with `--no-same-owner --same-permissions`. The fallback additionally
  requires app, worker, and gateway to have the same effective Compose UID:GID,
  and the sealed snapshot access model to contain exactly that one identity.
  It preserves and later verifies POSIX modes, file content, paths, and symlinks.
  The backup records whether recursive `getfacl --skip-base` or `getfattr`
  discovers extended ACLs/xattrs (including file capabilities). The fallback
  rejects either flag, as well as multiple identities. Those configurations
  require provider/server restore.

The fallback is executable only when the service identity has create/rename
rights. It refuses the unsupported client-root `chown` model:

```bash
export DND_DR_ARCHIVE_FALLBACK_ACCESS_MODEL=single-identity-posix-mode-no-acl
./scripts/dr-restore-nfs-archive.sh --project-name "$DR_PROJECT" \
  --archive "$DR_PLAINTEXT/nfs.tar.gz" \
  --access-model "$DR_PLAINTEXT/nfs-access-model.json"
```

After either method, verify archive checksums and canonical schemas before any
index command. Any mismatch stops the drill.

```bash
set -euo pipefail
sudo -u "#${APP_UID:-10001}" -g "#${APP_GID:-10001}" \
  sh -c 'cd "$1" && sha256sum --check -' sh "$DND_DATA_HOST_PATH" \
  < "$DR_PLAINTEXT/nfs-files.sha256"
sudo -u "#${APP_UID:-10001}" -g "#${APP_GID:-10001}" \
  node ./scripts/filesystem-manifest.mjs "$DND_DATA_HOST_PATH" \
  > "$DR_PLAINTEXT/restored-tree.jsonl"
cmp "$DR_PLAINTEXT/nfs-tree.jsonl" "$DR_PLAINTEXT/restored-tree.jsonl"
./scripts/dr-compose.sh --project-name "$DR_PROJECT" validate-content
printf 'nfs_restore_finished,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> "$DR_EVIDENCE/timeline.csv"
```

Do not recursively `chown`, use `tar --same-owner`, disable `root_squash`, or
continue after a permission/checksum error. Roll back by discarding the isolated
DR export and provisioning another empty target.

### 3. Restore and fingerprint PostgreSQL

Start only PostgreSQL under the guarded explicit project, restore into its new
project-scoped volume, and run current migrations:

```bash
set -euo pipefail
./scripts/dr-compose.sh --project-name "$DR_PROJECT" start-postgres
./scripts/dr-compose.sh --project-name "$DR_PROJECT" restore-postgres \
  < "$DR_PLAINTEXT/postgres.dump"
./scripts/dr-compose.sh --project-name "$DR_PROJECT" fingerprint-postgres \
  > "$DR_EVIDENCE/restored-fingerprints.csv"
cmp "$DR_EVIDENCE/source-fingerprints.csv" "$DR_EVIDENCE/restored-fingerprints.csv"
./scripts/dr-compose.sh --project-name "$DR_PROJECT" migrate
printf 'postgres_restore_finished,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> "$DR_EVIDENCE/timeline.csv"
```

The exact count/fingerprint comparison occurs before any intentional recovery
mutation. A difference in even one critical row fails the restore.

### 4. Reconcile active ingestion jobs transactionally

Redis and `upload_spool` intentionally start empty, so restored `queued` and
`processing` jobs cannot resume safely. Before app or worker startup, execute the
reviewed reconciliation transaction:

```bash
./scripts/dr-compose.sh --project-name "$DR_PROJECT" reconcile-ingestion \
  | tee "$DR_EVIDENCE/ingestion-reconciliation.log"
```

The SQL takes a transaction-scoped advisory lock, changes `processing` to
`failed` and `queued` to `cancelled`, sets `finished_at`, and stores actionable
instructions to re-upload the original file. It then proves no active job
remains before commit. This releases
`ingestion_jobs_one_active_file_idx`, whose actual predicate is
`file_id IS NOT NULL AND status IN ('queued', 'processing')`, so a replacement
upload for that file can create a new job. Any error rolls back the whole change.

### 5. Rebuild and measure the derived index

```bash
set -euo pipefail
./scripts/dr-compose.sh --project-name "$DR_PROJECT" index-clean-dry-run
./scripts/dr-compose.sh --project-name "$DR_PROJECT" index-clean
./scripts/dr-compose.sh --project-name "$DR_PROJECT" index-cardinality \
  > "$DR_EVIDENCE/index-cardinality.csv"
printf 'index_rebuild_finished,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> "$DR_EVIDENCE/timeline.csv"
```

Validation/checksum gates precede both index mutations. Activation is
transactional; a failed clean run leaves the prior restored index available for
inspection and can be retried after correcting the cause.

### 6. Start empty Redis and prove replaceability

```bash
set -euo pipefail
./scripts/dr-compose.sh --project-name "$DR_PROJECT" start-stack
./scripts/dr-compose.sh --project-name "$DR_PROJECT" status
./scripts/production-permissions-smoke.sh --project-name "$DR_PROJECT"
./scripts/production-replacement-smoke.sh --project-name "$DR_PROJECT"
./scripts/dr-compose.sh --project-name "$DR_PROJECT" recreate-gateway
./scripts/dr-compose.sh --project-name "$DR_PROJECT" wait-stack
```

Verify login, user/admin visibility, canonical browsing, keyword search, audit
history, and that reconciled jobs show the re-upload guidance. Confirm a new
upload for a previously active file can create a job; this is the behavioral
proof that active uniqueness was released. Only then record acceptance:

```bash
printf 'services_accepted,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> "$DR_EVIDENCE/timeline.csv"
```

Replacement smoke force-recreates app, worker, PostgreSQL, and Redis and proves
NFS, spool, database, and AOF marker persistence. Gateway is separately
recreated. Containers are replaceable because no authoritative state lives in
their layers.

### 7. Backfill embeddings after structured acceptance

```bash
./scripts/dr-compose.sh --project-name "$DR_PROJECT" backfill-embeddings
```

Provider failure leaves keyword search online. Retry only null active
NFS-managed embeddings after repairing rate limits/model/dimensions. A confirmed
bad-model rollback must scope an audited transaction to active NFS-managed rows;
never delete chunks or canonical files.

### 8. Seal evidence and guarded teardown

Sealing requires matching source/restored fingerprints, all timeline stages,
reconciliation output, index cardinality, and backup metadata. It computes
backup-pipeline seconds and measured RTO, then checksums the evidence set.

```bash
export DND_DR_EVIDENCE_SIGNING_SECRET_KEY_FILE=/run/secrets/dnd-dr-evidence-minisign.key
./scripts/seal-dr-evidence.sh --project-name "$DR_PROJECT" \
  --evidence-dir "$DR_EVIDENCE"
minisign -V -p /etc/dnd-firegory/evidence-minisign.pub \
  -m "$DR_EVIDENCE/EVIDENCE_COMPLETE.json" \
  -x "$DR_EVIDENCE/EVIDENCE_COMPLETE.json.minisig"
./scripts/dr-compose.sh --project-name "$DR_PROJECT" teardown
./scripts/dr-remove-plaintext.sh --project-name "$DR_PROJECT" \
  --path "$DR_PLAINTEXT"
./scripts/dr-target-guard.sh remove --project-name "$DR_PROJECT"
```

All three teardown commands remain explicit. `dr-compose` revalidates the marker,
including its hash of the current NFS mount identity,
before volume deletion, and marker removal revalidates it again. These commands
cannot target a production project because the guard accepts only `dnd94-dr-*`.
Provider-side deletion of the isolated DR export is a separately authorized
infrastructure action; this repository never recursively deletes NFS.

## Failure and rollback

| Failure | Response | Rollback |
| --- | --- | --- |
| Guard, prefix, opt-in, marker, or empty-target check fails | Stop; do not bypass the script or set an ambient project | Provision another empty DR target and initialize a new bound marker |
| Provider snapshot is absent, writable, or not atomic | Reject the set before backup | Select/create a verified immutable provider snapshot |
| Archive extraction/checksum/canonical validation fails | Never seal or index it | Quarantine the set and use another sealed replica/snapshot |
| NFS restore cannot write under `APP_UID:APP_GID` with `root_squash` | Stop; fix server/provider identity mapping | Discard the isolated export; never client-`chown` or disable `root_squash` |
| PostgreSQL restore/fingerprint differs | Keep schema consumers stopped | Discard only the DR project volume and restore another sealed set into a new DR project |
| Ingestion reconciliation fails | Transaction rolls back; app/worker stay stopped | Diagnose locks/schema, then rerun the same SQL; never hand-edit individual active jobs |
| Redis is missing/corrupt | Recreate empty `redis_data`; reconcile from PostgreSQL and authoritative input | No canonical rollback; Redis is never restored as authority |
| Index fails | Preserve NFS/PostgreSQL and inspect validation/staging logs | Retry after correction; restore a fresh PostgreSQL DR volume if a completed projector is behaviorally invalid |
| Embedding fails | Keep keyword search available and record degraded ETA | Clear only reviewed bad-model active NFS embeddings, then rerun backfill |
| Replacement image fails | Preserve NFS and named volumes | Recreate from the recorded previous tested commit; never delete production volumes |

Static tests verify guard failures, explicit project flags, command paths,
Compose/schema consistency, checksum/index ordering, fingerprint comparison,
reconciliation semantics, root-squash-safe extraction, encryption requirements,
and rejection of unsafe variants. Only a live provider/NFS/PostgreSQL drill can
prove provider snapshot atomicity, server identity mapping, throughput,
recovery-key access, and measured production-scale RPO/RTO.
