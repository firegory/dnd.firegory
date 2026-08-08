#!/bin/sh
set -eu

[ "$#" -eq 4 ] && [ "$1" = "--project-name" ] && [ "$3" = "--evidence-dir" ] || {
  echo "Usage: $0 --project-name <dnd94-dr-name> --evidence-dir <absolute-path>" >&2
  exit 2
}
project=$2
evidence_dir=$4
evidence_root=${DND_DR_EVIDENCE_ROOT:-}
signing_key=${DND_DR_EVIDENCE_SIGNING_SECRET_KEY_FILE:-}
case "$evidence_dir" in /*) ;; *) echo "Evidence directory must be absolute" >&2; exit 1 ;; esac
case "$evidence_root" in /*) ;; *) echo "DND_DR_EVIDENCE_ROOT must be absolute" >&2; exit 1 ;; esac
[ "$evidence_dir" = "$(readlink -m "$evidence_root")/$project" ] || { echo "Evidence path must exactly match the DR project" >&2; exit 1; }
[ -d "$evidence_dir" ] && [ ! -L "$evidence_dir" ] || { echo "Evidence path must be a non-symlink directory" >&2; exit 1; }
[ -r "$signing_key" ] || { echo "DND_DR_EVIDENCE_SIGNING_SECRET_KEY_FILE must be readable" >&2; exit 1; }
command -v minisign >/dev/null || { echo "minisign is required to seal evidence" >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
"$script_dir/dr-target-guard.sh" verify --project-name "$project" >/dev/null
. "$script_dir/dr-docker-socket.sh"
dr_docker_socket_initialize
[ ! -e "$evidence_dir/EVIDENCE_COMPLETE.json" ] || { echo "Evidence is already sealed" >&2; exit 1; }
for file in backup-metadata.json COMPLETE.json timeline.csv source-fingerprints.csv \
  restored-fingerprints.csv ingestion-reconciliation.log index-cardinality.csv; do
  [ -s "$evidence_dir/$file" ] || { echo "Required evidence is missing: $file" >&2; exit 1; }
done
cmp "$evidence_dir/source-fingerprints.csv" "$evidence_dir/restored-fingerprints.csv"

node --input-type=module --eval '
  import { readFileSync, writeFileSync } from "node:fs";
  const directory = process.argv[1];
  const project = process.argv[2];
  const dockerSocket = process.argv[3];
  const backup = JSON.parse(readFileSync(`${directory}/backup-metadata.json`, "utf8"));
  const complete = JSON.parse(readFileSync(`${directory}/COMPLETE.json`, "utf8"));
  const rows = readFileSync(`${directory}/timeline.csv`, "utf8").trim().split("\n").slice(1).map((line) => {
    const comma = line.indexOf(",");
    return [line.slice(0, comma), line.slice(comma + 1)];
  });
  const events = Object.fromEntries(rows);
  const required = ["drill_started", "nfs_restore_finished", "postgres_restore_finished", "index_rebuild_finished", "services_accepted"];
  for (const event of required) if (Number.isNaN(Date.parse(events[event]))) throw new Error(`Missing or invalid timeline event: ${event}`);
  for (let index = 1; index < required.length; index++) {
    if (Date.parse(events[required[index]]) < Date.parse(events[required[index - 1]])) throw new Error("DR timeline is not monotonic");
  }
  const summary = {
    schemaVersion: 1,
    project,
    dockerSocket,
    sourceSnapshotTime: backup.sourceSnapshotTime,
    postgresDumpStarted: backup.postgresDumpStarted,
    postgresDumpFinished: backup.postgresDumpFinished,
    replicationCompletedAt: complete.replicationCompletedAt,
    backupPipelineSeconds: Math.round((Date.parse(complete.replicationCompletedAt) - Date.parse(backup.sourceSnapshotTime)) / 1000),
    drillStarted: events.drill_started,
    servicesAccepted: events.services_accepted,
    measuredRtoSeconds: Math.round((Date.parse(events.services_accepted) - Date.parse(events.drill_started)) / 1000),
    stageDurationsSeconds: {
      nfsRestore: Math.round((Date.parse(events.nfs_restore_finished) - Date.parse(events.drill_started)) / 1000),
      postgresRestoreAndVerification: Math.round((Date.parse(events.postgres_restore_finished) - Date.parse(events.nfs_restore_finished)) / 1000),
      indexRebuild: Math.round((Date.parse(events.index_rebuild_finished) - Date.parse(events.postgres_restore_finished)) / 1000),
      serviceAcceptance: Math.round((Date.parse(events.services_accepted) - Date.parse(events.index_rebuild_finished)) / 1000),
    },
    stageFinishedAt: Object.fromEntries(required.slice(1).map((event) => [event, events[event]])),
  };
  if (summary.backupPipelineSeconds < 0 || summary.measuredRtoSeconds < 0) throw new Error("Evidence contains negative elapsed time");
  writeFileSync(`${directory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o400, flag: "wx" });
' "$evidence_dir" "$project" "$dr_docker_socket"
(
  cd "$evidence_dir"
  sha256sum backup-metadata.json COMPLETE.json timeline.csv source-fingerprints.csv \
    restored-fingerprints.csv ingestion-reconciliation.log index-cardinality.csv summary.json \
    > evidence.sha256
  sha256sum --check evidence.sha256
)
sealed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
summary_sha=$(sha256sum "$evidence_dir/summary.json" | cut -d ' ' -f 1)
manifest_sha=$(sha256sum "$evidence_dir/evidence.sha256" | cut -d ' ' -f 1)
printf '{\n  "schemaVersion": 1,\n  "project": "%s",\n  "sealedAt": "%s",\n  "summarySha256": "%s",\n  "evidenceManifestSha256": "%s"\n}\n' \
  "$project" "$sealed_at" "$summary_sha" "$manifest_sha" > "$evidence_dir/EVIDENCE_COMPLETE.json"
chmod 0400 "$evidence_dir"/*
minisign -S -s "$signing_key" -m "$evidence_dir/EVIDENCE_COMPLETE.json" -x "$evidence_dir/EVIDENCE_COMPLETE.json.minisig"
chmod 0400 "$evidence_dir/EVIDENCE_COMPLETE.json.minisig"
echo "DR evidence fingerprints match and evidence is sealed."
