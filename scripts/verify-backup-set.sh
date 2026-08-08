#!/bin/sh
set -eu

[ "$#" -eq 2 ] && [ "$1" = "--backup-dir" ] || {
  echo "Usage: $0 --backup-dir <sealed-replica-directory>" >&2
  exit 2
}
backup_dir=$2
public_key=${DND_BACKUP_SIGNING_PUBLIC_KEY_FILE:-}
case "$backup_dir" in /*) ;; *) echo "Backup directory must be absolute" >&2; exit 1 ;; esac
[ -r "$public_key" ] || { echo "DND_BACKUP_SIGNING_PUBLIC_KEY_FILE must be readable" >&2; exit 1; }
command -v minisign >/dev/null || { echo "minisign is required to verify a backup" >&2; exit 1; }
[ -f "$backup_dir/COMPLETE.json" ] || { echo "Sealed COMPLETE.json is missing" >&2; exit 1; }
for file in backup-metadata.json backup-set.sha256 nfs.tar.gz.age nfs-files.sha256.age \
  nfs-tree.jsonl.age nfs-validation.json.age postgres.dump.age postgres.toc.age \
  source-fingerprints.csv.age; do
  [ -s "$backup_dir/$file" ] || { echo "Required backup artifact is missing: $file" >&2; exit 1; }
done
minisign -V -p "$public_key" -m "$backup_dir/backup-set.sha256" -x "$backup_dir/backup-set.sha256.minisig"
minisign -V -p "$public_key" -m "$backup_dir/COMPLETE.json" -x "$backup_dir/COMPLETE.json.minisig"
(
  cd "$backup_dir"
  sha256sum --check backup-set.sha256
)
node --input-type=module --eval '
  import assert from "node:assert/strict";
  import { createHash } from "node:crypto";
  import { readFileSync } from "node:fs";
  const directory = process.argv[1];
  const metadataText = readFileSync(`${directory}/backup-metadata.json`, "utf8");
  const checksums = readFileSync(`${directory}/backup-set.sha256`, "utf8");
  const checksumSignature = readFileSync(`${directory}/backup-set.sha256.minisig`, "utf8");
  const complete = JSON.parse(readFileSync(`${directory}/COMPLETE.json`, "utf8"));
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(complete.metadataSha256, digest(metadataText));
  assert.equal(complete.checksumManifestSha256, digest(checksums));
  assert.equal(complete.checksumSignatureSha256, digest(checksumSignature));
  assert.equal(complete.sourceSnapshotTime, JSON.parse(metadataText).sourceSnapshotTime);
  assert.ok(!Number.isNaN(Date.parse(complete.replicationCompletedAt)));
' "$backup_dir"
echo "Sealed encrypted backup set is internally consistent."
