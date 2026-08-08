#!/bin/bash
set -euo pipefail

usage() {
  echo "Usage: $0 --project-name <name> --snapshot-path <read-only-nfs> --snapshot-id <id> --snapshot-time <ISO-8601> --backup-dir <empty-dir> --age-recipient <recipient>" >&2
  exit 2
}

project= snapshot_path= snapshot_id= snapshot_time= backup_dir= age_recipient=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-name|--snapshot-path|--snapshot-id|--snapshot-time|--backup-dir|--age-recipient)
      [ "$#" -ge 2 ] || usage
      name=${1#--}; name=${name//-/_}
      printf -v "$name" '%s' "$2"
      shift 2
      ;;
    *) usage ;;
  esac
done
for required in project snapshot_path snapshot_id snapshot_time backup_dir age_recipient; do
  [ -n "${!required}" ] || usage
done
case "$project" in *[!a-zA-Z0-9_.-]*) echo "Invalid Compose project name" >&2; exit 1 ;; esac
case "$snapshot_path:$backup_dir" in /*:/*) ;; *) echo "Snapshot and backup paths must be absolute" >&2; exit 1 ;; esac
case "$snapshot_id" in *[!a-zA-Z0-9_.:-]*) echo "Invalid provider snapshot ID" >&2; exit 1 ;; esac
case "$snapshot_time" in *[!0-9TZ:+.-]*) echo "Invalid source snapshot time" >&2; exit 1 ;; esac
date --date "$snapshot_time" --utc +%Y-%m-%dT%H:%M:%SZ >/dev/null
command -v age >/dev/null || { echo "age is required for encrypted backup artifacts" >&2; exit 1; }
command -v findmnt >/dev/null || { echo "findmnt is required" >&2; exit 1; }
[ -d "$snapshot_path" ] || { echo "Snapshot path is not a directory" >&2; exit 1; }
[ -d "$backup_dir" ] || { echo "Backup directory must already exist" >&2; exit 1; }
[ -z "$(find "$backup_dir" -mindepth 1 -maxdepth 1 -print -quit)" ] || { echo "Backup directory must be empty" >&2; exit 1; }

filesystem=$(findmnt --noheadings --raw --output FSTYPE --target "$snapshot_path")
options=$(findmnt --noheadings --raw --output OPTIONS --target "$snapshot_path")
case "$filesystem" in nfs|nfs4) ;; *) echo "Snapshot must be on NFS" >&2; exit 1 ;; esac
case ",$options," in *,ro,*) ;; *) echo "Provider snapshot mount must be read-only" >&2; exit 1 ;; esac

plaintext_root=${DND_BACKUP_PLAINTEXT_TMPDIR:-/dev/shm}
[ -d "$plaintext_root" ] || { echo "Plaintext tmpfs does not exist" >&2; exit 1; }
[ "$(findmnt --noheadings --raw --output FSTYPE --target "$plaintext_root")" = tmpfs ] || {
  echo "DND_BACKUP_PLAINTEXT_TMPDIR must be tmpfs; plaintext may not touch persistent disk" >&2
  exit 1
}
work=$(mktemp -d "$plaintext_root/dnd-backup.XXXXXX")
exporter_pid=
cleanup() {
  if [ -n "$exporter_pid" ] && kill -0 "$exporter_pid" 2>/dev/null; then
    printf 'ROLLBACK;\n\\q\n' >&9 2>/dev/null || true
    exec 9>&- || true
    wait "$exporter_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
compose() { docker compose --project-name "$project" --file compose.production.yml "$@"; }

source_commit=$(git rev-parse HEAD)
nfs_verify_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DND_DATA_HOST_PATH="$snapshot_path" compose run --rm --no-deps --build worker \
  node --experimental-strip-types scripts/content-index.mts validate > "$work/nfs-validation.json"
(
  cd "$snapshot_path"
  find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
) > "$work/nfs-files.sha256"
node scripts/filesystem-manifest.mjs "$snapshot_path" > "$work/nfs-tree.jsonl"
tar --create --gzip --file "$work/nfs.tar.gz" --one-file-system --directory "$snapshot_path" .
mkdir "$work/extracted"
tar --extract --gzip --file "$work/nfs.tar.gz" --no-same-owner --directory "$work/extracted"
(
  cd "$work/extracted"
  sha256sum --check "$work/nfs-files.sha256"
)
node scripts/filesystem-manifest.mjs "$work/extracted" > "$work/extracted-tree.jsonl"
cmp "$work/nfs-tree.jsonl" "$work/extracted-tree.jsonl"
nfs_verify_finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)

fifo="$work/exporter.fifo"
mkfifo "$fifo"
compose exec -T postgres psql --username "${POSTGRES_USER:-dnd}" --dbname "${POSTGRES_DB:-dnd_firegory}" \
  --no-psqlrc --quiet --tuples-only --no-align > "$work/exporter.out" < "$fifo" &
exporter_pid=$!
exec 9>"$fifo"
printf '\\set ON_ERROR_STOP on\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' >&9

pg_snapshot=
for _ in $(seq 1 100); do
  pg_snapshot=$(grep -E '^[0-9A-Fa-f-]+$' "$work/exporter.out" | tail -n 1 || true)
  [ -n "$pg_snapshot" ] && break
  kill -0 "$exporter_pid" 2>/dev/null || { echo "PostgreSQL snapshot exporter exited" >&2; exit 1; }
  sleep 0.1
done
[ -n "$pg_snapshot" ] || { echo "Timed out exporting PostgreSQL snapshot" >&2; exit 1; }

pg_dump_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
compose exec -T postgres pg_dump --username "${POSTGRES_USER:-dnd}" \
  --dbname "${POSTGRES_DB:-dnd_firegory}" --format custom --no-owner --no-acl \
  --snapshot "$pg_snapshot" > "$work/postgres.dump"
compose exec -T postgres psql --username "${POSTGRES_USER:-dnd}" --dbname "${POSTGRES_DB:-dnd_firegory}" \
  --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
  --command "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" \
  --command "SET TRANSACTION SNAPSHOT '$pg_snapshot'" --file - \
  < scripts/dr-critical-fingerprint.sql > "$work/source-fingerprints.csv"
compose exec -T postgres pg_restore --list < "$work/postgres.dump" > "$work/postgres.toc"
printf 'COMMIT;\n\\q\n' >&9
exec 9>&-
wait "$exporter_pid"
exporter_pid=
pg_dump_finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)

for table in users sessions search_events rag_events compendium_import_audit \
  compendium_import_review_audit compendium_editor_audit ingestion_jobs; do
  grep -Eq "TABLE DATA public ${table} " "$work/postgres.toc"
  grep -Eq "^${table},[0-9]+,[0-9a-f]{64}$" "$work/source-fingerprints.csv"
done

for artifact in nfs.tar.gz nfs-files.sha256 nfs-tree.jsonl nfs-validation.json postgres.dump postgres.toc source-fingerprints.csv; do
  age --recipient "$age_recipient" --output "$backup_dir/$artifact.age" "$work/$artifact"
done
generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{\n  "schemaVersion": 1,\n  "sourceCommit": "%s",\n  "providerSnapshotId": "%s",\n  "sourceSnapshotTime": "%s",\n  "nfsVerificationStarted": "%s",\n  "nfsVerificationFinished": "%s",\n  "postgresSnapshotId": "%s",\n  "postgresDumpStarted": "%s",\n  "postgresDumpFinished": "%s",\n  "backupGeneratedAt": "%s",\n  "encryption": "age-recipient"\n}\n' \
  "$source_commit" "$snapshot_id" "$snapshot_time" "$nfs_verify_started" "$nfs_verify_finished" \
  "$pg_snapshot" "$pg_dump_started" "$pg_dump_finished" "$generated_at" > "$backup_dir/backup-metadata.json"
(
  cd "$backup_dir"
  sha256sum backup-metadata.json ./*.age > backup-set.sha256
  sha256sum --check backup-set.sha256
)
chmod 0400 "$backup_dir"/*
echo "Encrypted backup set created without COMPLETE; replicate and seal it."
