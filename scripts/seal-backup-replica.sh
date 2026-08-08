#!/bin/sh
set -eu

[ "$#" -eq 2 ] && [ "$1" = "--backup-dir" ] || {
  echo "Usage: $0 --backup-dir <replicated-backup-directory>" >&2
  exit 2
}
backup_dir=$2
signing_key=${DND_BACKUP_SIGNING_SECRET_KEY_FILE:-}
case "$backup_dir" in /*) ;; *) echo "Backup directory must be absolute" >&2; exit 1 ;; esac
[ -r "$signing_key" ] || { echo "DND_BACKUP_SIGNING_SECRET_KEY_FILE must be readable" >&2; exit 1; }
command -v minisign >/dev/null || { echo "minisign is required to seal a backup" >&2; exit 1; }
[ -d "$backup_dir" ] || { echo "Backup directory does not exist" >&2; exit 1; }
[ ! -e "$backup_dir/COMPLETE.json" ] || { echo "Replica is already sealed" >&2; exit 1; }
for file in backup-metadata.json backup-set.sha256 nfs.tar.gz.age nfs-files.sha256.age \
  nfs-tree.jsonl.age nfs-validation.json.age postgres.dump.age postgres.toc.age \
  source-fingerprints.csv.age; do
  [ -s "$backup_dir/$file" ] || { echo "Required backup artifact is missing: $file" >&2; exit 1; }
done
(
  cd "$backup_dir"
  sha256sum --check backup-set.sha256
  minisign -S -s "$signing_key" -m backup-set.sha256 -x backup-set.sha256.minisig
)
node --input-type=module --eval '
  import { readFileSync, writeFileSync } from "node:fs";
  import { createHash } from "node:crypto";
  const directory = process.argv[1];
  const metadataText = readFileSync(`${directory}/backup-metadata.json`, "utf8");
  const checksums = readFileSync(`${directory}/backup-set.sha256`, "utf8");
  const checksumSignature = readFileSync(`${directory}/backup-set.sha256.minisig`, "utf8");
  const metadata = JSON.parse(metadataText);
  for (const key of ["sourceSnapshotTime", "postgresDumpStarted", "postgresDumpFinished", "backupGeneratedAt"]) {
    if (Number.isNaN(Date.parse(metadata[key]))) throw new Error(`Invalid backup metadata field: ${key}`);
  }
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  writeFileSync(`${directory}/COMPLETE.json`, `${JSON.stringify({
    schemaVersion: 1,
    sourceSnapshotTime: metadata.sourceSnapshotTime,
    replicationCompletedAt: new Date().toISOString(),
    metadataSha256: digest(metadataText),
    checksumManifestSha256: digest(checksums),
    checksumSignatureSha256: digest(checksumSignature),
  }, null, 2)}\n`, { mode: 0o400, flag: "wx" });
' "$backup_dir"
minisign -S -s "$signing_key" -m "$backup_dir/COMPLETE.json" -x "$backup_dir/COMPLETE.json.minisig"
chmod 0400 "$backup_dir/backup-set.sha256.minisig" "$backup_dir/COMPLETE.json.minisig"
echo "Replica checksums verified and COMPLETE.json sealed."
