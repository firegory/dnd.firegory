import { readFileSync } from "node:fs";
import process from "node:process";

const metadataPath = process.argv[2];
const mode = process.argv[3];
const modeValue = process.argv[4];
if (!metadataPath || (mode && !["--complete", "--replication-time"].includes(mode)) || (mode && !modeValue)) {
  throw new Error("Usage: node scripts/validate-backup-chronology.mjs <metadata> [--complete <path>|--replication-time <ISO-8601>]");
}

const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const orderedFields = [
  "sourceSnapshotTime",
  "backupStartedAt",
  "nfsVerificationStarted",
  "nfsVerificationFinished",
  "postgresSnapshotExportedAt",
  "postgresDumpStarted",
  "postgresDumpFinished",
  "backupGeneratedAt",
];
const futureLimit = Date.now() + 5 * 60 * 1000;
const strictUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function parseTimestamp(name, value) {
  if (typeof value !== "string" || !strictUtc.test(value)) throw new Error(`Invalid UTC timestamp: ${name}`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || parsed > futureLimit) throw new Error(`Invalid or future timestamp: ${name}`);
  return parsed;
}

const ordered = orderedFields.map((field) => [field, parseTimestamp(field, metadata[field])]);
for (let index = 1; index < ordered.length; index++) {
  if (ordered[index][1] < ordered[index - 1][1]) {
    throw new Error(`Backup chronology is not monotonic: ${ordered[index][0]} precedes ${ordered[index - 1][0]}`);
  }
}

if (mode) {
  let replicationTime;
  if (mode === "--complete") {
    const complete = JSON.parse(readFileSync(modeValue, "utf8"));
    if (complete.sourceSnapshotTime !== metadata.sourceSnapshotTime) throw new Error("COMPLETE source snapshot does not match metadata");
    replicationTime = complete.replicationCompletedAt;
  } else {
    replicationTime = modeValue;
  }
  const replication = parseTimestamp("replicationCompletedAt", replicationTime);
  if (replication < ordered.at(-1)[1]) throw new Error("Replication completed before backup generation");
}

process.stdout.write("Backup chronology is valid.\n");
