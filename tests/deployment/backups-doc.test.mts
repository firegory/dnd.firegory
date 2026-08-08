import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { constants } from "node:fs";
import { parse } from "yaml";

const root = new URL("../..", import.meta.url);
const backups = await readFile(new URL("../../docs/backups.md", import.meta.url), "utf8");
const composeSource = await readFile(new URL("../../compose.production.yml", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
const migration = await readFile(new URL("../../migrations/0006_ingestion_generation_integrity.sql", import.meta.url), "utf8");
const guard = await readFile(new URL("../../scripts/dr-target-guard.sh", import.meta.url), "utf8");
const drCompose = await readFile(new URL("../../scripts/dr-compose.sh", import.meta.url), "utf8");
const createBackup = await readFile(new URL("../../scripts/create-backup-set.sh", import.meta.url), "utf8");
const sealReplica = await readFile(new URL("../../scripts/seal-backup-replica.sh", import.meta.url), "utf8");
const verifyBackup = await readFile(new URL("../../scripts/verify-backup-set.sh", import.meta.url), "utf8");
const reconcile = await readFile(new URL("../../scripts/dr-reconcile-ingestion.sql", import.meta.url), "utf8");
const restoreNfs = await readFile(new URL("../../scripts/dr-restore-nfs-archive.sh", import.meta.url), "utf8");
const removePlaintext = await readFile(new URL("../../scripts/dr-remove-plaintext.sh", import.meta.url), "utf8");
const fingerprints = await readFile(new URL("../../scripts/dr-critical-fingerprint.sql", import.meta.url), "utf8");
const evidence = await readFile(new URL("../../scripts/seal-dr-evidence.sh", import.meta.url), "utf8");
const permissionsSmoke = await readFile(new URL("../../scripts/production-permissions-smoke.sh", import.meta.url), "utf8");
const replacementSmoke = await readFile(new URL("../../scripts/production-replacement-smoke.sh", import.meta.url), "utf8");
const productionSmoke = await readFile(new URL("../../scripts/production-smoke.sh", import.meta.url), "utf8");
const compose = parse(composeSource) as { services: Record<string, unknown>; volumes: Record<string, unknown> };

function bashBlocks(section = backups): string[] {
  return [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
}

test("runbook matches production paths, identities, services, and volumes", () => {
  for (const value of ["/mnt/dnd-firegory", "/app/content-repository", "APP_UID", "APP_GID", "postgres_data", "redis_data", "upload_spool"]) {
    assert.ok(backups.includes(value), value);
  }
  for (const service of ["app", "worker", "gateway", "migrate", "postgres", "redis"]) assert.ok(compose.services[service]);
  assert.deepEqual(Object.keys(compose.volumes).sort(), ["postgres_data", "redis_data", "upload_spool"]);
  assert.match(composeSource, /user: "\$\{APP_UID:-10001\}:\$\{APP_GID:-10001\}"/);
  assert.match(dockerfile, /COPY --chown=10001:10001 scripts \.\/scripts/);
});

test("every referenced repository script exists and executable shell scripts have valid syntax", async () => {
  const paths = new Set([...backups.matchAll(/\.\/(scripts\/[a-z0-9.-]+)/g)].map((match) => match[1]));
  for (const expected of [
    "scripts/create-backup-set.sh",
    "scripts/dr-compose.sh",
    "scripts/dr-target-guard.sh",
    "scripts/filesystem-manifest.mjs",
    "scripts/dr-critical-fingerprint.sql",
    "scripts/dr-reconcile-ingestion.sql",
    "scripts/dr-restore-nfs-archive.sh",
    "scripts/dr-remove-plaintext.sh",
    "scripts/seal-backup-replica.sh",
    "scripts/seal-dr-evidence.sh",
    "scripts/verify-backup-set.sh",
  ]) assert.ok(paths.has(expected), expected);
  for (const path of paths) await access(new URL(`../../${path}`, import.meta.url));

  const shellScripts = [
    "scripts/create-backup-set.sh",
    "scripts/dr-compose.sh",
    "scripts/dr-target-guard.sh",
    "scripts/dr-restore-nfs-archive.sh",
    "scripts/dr-remove-plaintext.sh",
    "scripts/production-permissions-smoke.sh",
    "scripts/production-replacement-smoke.sh",
    "scripts/production-smoke.sh",
    "scripts/seal-backup-replica.sh",
    "scripts/seal-dr-evidence.sh",
    "scripts/verify-backup-set.sh",
  ];
  for (const path of shellScripts) {
    await access(new URL(`../../${path}`, import.meta.url), constants.X_OK);
    const shell = path.endsWith("create-backup-set.sh") ? "bash" : "sh";
    const result = spawnSync(shell, ["-n", path], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }
  for (const [index, block] of bashBlocks().entries()) {
    const result = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
    assert.equal(result.status, 0, `documented Bash block ${index + 1}: ${result.stderr}`);
  }
});

test("DR Compose scope is explicit and ambient or nested overrides are rejected", () => {
  const drill = backups.slice(backups.indexOf("## Empty-environment restore drill"));
  for (const block of bashBlocks(drill)) {
    assert.doesNotMatch(block, /\bdocker compose\b/);
    for (const line of block.split("\n").filter((value) => value.includes("dr-compose.sh"))) {
      assert.match(line, /dr-compose\.sh --project-name "\$DR_PROJECT"/);
    }
  }
  assert.doesNotMatch(bashBlocks(drill).join("\n"), /COMPOSE_PROJECT_NAME/);
  assert.doesNotMatch(productionSmoke, /COMPOSE_PROJECT_NAME/);
  assert.match(drCompose, /dr-target-guard\.sh" verify --project-name "\$project"/);
  assert.match(drCompose, /docker compose --project-name "\$project" --file compose\.production\.yml/);
  assert.match(drCompose, /Nested Compose project overrides are forbidden/);
  for (const script of [permissionsSmoke, replacementSmoke]) {
    assert.match(script, /"\$1" = "--project-name"/);
    assert.match(script, /dr-target-guard\.sh" verify --project-name "\$project"/);
    assert.match(script, /docker compose --project-name "\$project" --file compose\.production\.yml/);
  }
  assert.match(productionSmoke, /project="dnd94-dr-smoke-\$\$"/);
  assert.match(productionSmoke, /dr-compose\.sh --project-name "\$project" down --volumes/);
});

test("DR target guard fails closed and binds an empty target to one project", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "dnd-dr-guard-"));
  const data = join(temporary, "data");
  const marker = join(temporary, "target.marker");
  await mkdir(data);
  const baseEnv = {
    ...process.env,
    DND_DATA_HOST_PATH: data,
    DND_DR_PRODUCTION_DATA_PATH: join(temporary, "production-data"),
    DND_DR_EMPTY_TARGET_MARKER: marker,
    DND_NFS_PREFLIGHT_TEST_MODE: "1",
    DND_DR_GUARD_TEST_MODE: "1",
  };
  const run = (args: string[], env = baseEnv) => spawnSync("sh", ["scripts/dr-target-guard.sh", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  try {
    assert.notEqual(run(["initialize", "--project-name", "production"]).status, 0);
    assert.notEqual(run(["initialize", "--project-name", "dnd94-dr-smoke-test"]).status, 0);
    await writeFile(join(data, "existing"), "x");
    assert.notEqual(run(["initialize", "--project-name", "dnd94-dr-smoke-test"], {
      ...baseEnv,
      DND_DR_OPT_IN: "I_UNDERSTAND_DND_FIREGORY_DR_IS_DESTRUCTIVE",
    }).status, 0);
    await rm(join(data, "existing"));
    const authorized = { ...baseEnv, DND_DR_OPT_IN: "I_UNDERSTAND_DND_FIREGORY_DR_IS_DESTRUCTIVE" };
    assert.notEqual(run(["initialize", "--project-name", "dnd94-dr-test"], authorized).status, 0);
    assert.equal(run(["initialize", "--project-name", "dnd94-dr-smoke-test"], authorized).status, 0);
    assert.equal(run(["verify", "--project-name", "dnd94-dr-smoke-test"], authorized).status, 0);
    assert.notEqual(run(["verify", "--project-name", "dnd94-dr-smoke-other"], authorized).status, 0);
    assert.notEqual(run(["verify", "--project-name", "dnd94-dr-smoke-test"], {
      ...authorized,
      DND_DR_PRODUCTION_DATA_PATH: data,
    }).status, 0);
    assert.equal(run(["remove", "--project-name", "dnd94-dr-smoke-test"], authorized).status, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("backup accepts only a read-only provider snapshot and verifies extracted content before sealing", () => {
  assert.match(createBackup, /findmnt[\s\S]*FSTYPE[\s\S]*nfs\|nfs4/);
  assert.match(createBackup, /findmnt[\s\S]*OPTIONS[\s\S]*\*,ro,\*/);
  assert.match(createBackup, /content-index\.mts validate/);
  const extract = createBackup.indexOf("tar --extract");
  const verify = createBackup.indexOf("sha256sum --check", extract);
  const treeCompare = createBackup.indexOf('cmp "$work/nfs-tree.jsonl"', verify);
  const encrypt = createBackup.indexOf("age --recipient", treeCompare);
  assert.ok(extract >= 0 && verify > extract && treeCompare > verify && encrypt > treeCompare);
  assert.doesNotMatch(createBackup, /COMPLETE\.json/);
  assert.match(sealReplica, /sha256sum --check backup-set\.sha256[\s\S]*COMPLETE\.json/);
  assert.match(sealReplica, /minisign -S[\s\S]*backup-set\.sha256[\s\S]*minisign -S[\s\S]*COMPLETE\.json/);
  assert.match(verifyBackup, /minisign -V[\s\S]*backup-set\.sha256[\s\S]*minisign -V[\s\S]*COMPLETE\.json/);
  assert.match(verifyBackup, /metadataSha256[\s\S]*checksumManifestSha256/);
  assert.match(guard, /SOURCE,FSROOT,FSTYPE,OPTIONS[\s\S]*mount_sha256/);
  assert.match(guard, /Refusing the configured production NFS path/);
  const backupCommands = bashBlocks(backups.slice(0, backups.indexOf("## Empty-environment restore drill"))).join("\n");
  assert.doesNotMatch(backupCommands, /\b(?:worker\s+stop|stop\s+worker)\b/);
  assert.doesNotMatch(createBackup, /compose stop|compose\s+\w+\s+stop/);
});

test("filesystem manifest detects files, directories, symlinks, and archive drift", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "dnd-tree-manifest-"));
  try {
    await mkdir(join(temporary, "directory"));
    await writeFile(join(temporary, "directory", "entry.json"), "one");
    await symlink("directory/entry.json", join(temporary, "active"));
    const first = spawnSync(process.execPath, ["scripts/filesystem-manifest.mjs", temporary], { cwd: root, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const entries = first.stdout.trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(entries.map((entry) => entry.type).sort(), ["directory", "file", "symlink"]);
    await writeFile(join(temporary, "directory", "entry.json"), "longer");
    const second = spawnSync(process.execPath, ["scripts/filesystem-manifest.mjs", temporary], { cwd: root, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.notEqual(second.stdout, first.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("root-squash restore never claims client-root ownership", () => {
  const drillBlocks = bashBlocks(backups.slice(backups.indexOf("### 2. Restore canonical NFS"))).join("\n");
  assert.match(drillBlocks, /dr-restore-nfs-archive\.sh --project-name "\$DR_PROJECT"/);
  assert.match(restoreNfs, /dr-target-guard\.sh" verify --project-name "\$project"/);
  assert.match(restoreNfs, /sudo -u "#\$uid" -g "#\$gid"/);
  assert.match(restoreNfs, /tar --extract --gzip --no-same-owner/);
  assert.doesNotMatch(drillBlocks, /--same-owner|\bchown\b|--numeric-owner/);
  assert.match(backups, /provider\/server restores or clones/);
  assert.match(backups, /Do not recursively `chown`/);
});

test("critical fingerprints use the same PostgreSQL snapshot and must match before reconciliation", () => {
  for (const table of ["users", "sessions", "search_events", "rag_events", "compendium_import_audit", "compendium_import_review_audit", "compendium_editor_audit", "ingestion_jobs"]) {
    assert.match(fingerprints, new RegExp(`'${table}'`));
  }
  assert.match(fingerprints, /digest\([\s\S]*'sha256'/);
  assert.doesNotMatch(fingerprints, /ON COMMIT DROP/);
  assert.match(createBackup, /pg_export_snapshot/);
  assert.match(createBackup, /pg_dump[\s\S]*--snapshot "\$pg_snapshot"/);
  assert.match(createBackup, /SET TRANSACTION SNAPSHOT '\$pg_snapshot'/);
  const compare = backups.indexOf('cmp "$DR_EVIDENCE/source-fingerprints.csv"');
  const reconcileCommand = backups.indexOf("scripts/dr-reconcile-ingestion.sql");
  assert.ok(compare >= 0 && reconcileCommand > compare);
  assert.match(evidence, /cmp "\$evidence_dir\/source-fingerprints\.csv" "\$evidence_dir\/restored-fingerprints\.csv"/);
});

test("ingestion reconciliation matches schema and releases active uniqueness atomically", () => {
  assert.match(migration, /ingestion_jobs_one_active_file_idx[\s\S]*status IN \('queued', 'processing'\)/);
  assert.match(reconcile, /^BEGIN;/);
  assert.match(reconcile, /pg_advisory_xact_lock/);
  assert.match(reconcile, /WHEN 'processing' THEN 'failed'::ingestion_job_status/);
  assert.match(reconcile, /ELSE 'cancelled'::ingestion_job_status/);
  assert.match(reconcile, /finished_at = clock_timestamp\(\)/);
  assert.match(reconcile, /Re-upload the original file and start a new ingestion job/);
  assert.match(reconcile, /IF EXISTS \(SELECT 1 FROM ingestion_jobs WHERE status IN \('queued', 'processing'\)\)/);
  assert.match(reconcile, /COMMIT;/);
  assert.doesNotMatch(reconcile, /DELETE FROM ingestion_jobs/);
});

test("checksum validation and reconciliation precede index mutation and acceptance", () => {
  const drill = backups.indexOf("## Empty-environment restore drill");
  const checksum = backups.indexOf("sha256sum --check -", drill);
  const validate = backups.indexOf("scripts/content-index.mts validate", drill);
  const reconcileStep = backups.indexOf("scripts/dr-reconcile-ingestion.sql", drill);
  const dryRun = backups.indexOf("scripts/content-index.mts clean --dry-run", drill);
  const clean = backups.indexOf("scripts/content-index.mts clean\n", drill);
  const acceptance = backups.indexOf("services_accepted", drill);
  assert.ok(checksum > drill && validate > checksum && reconcileStep > validate);
  assert.ok(dryRun > reconcileStep && clean > dryRun && acceptance > clean);
});

test("metadata and evidence make RPO/RTO and cardinality measurable", () => {
  for (const field of ["sourceSnapshotTime", "postgresDumpStarted", "postgresDumpFinished", "backupGeneratedAt"]) {
    assert.match(createBackup, new RegExp(field));
  }
  assert.match(sealReplica, /replicationCompletedAt/);
  for (const event of ["drill_started", "nfs_restore_finished", "postgres_restore_finished", "index_rebuild_finished", "services_accepted"]) {
    assert.match(backups, new RegExp(event));
    assert.match(evidence, new RegExp(event));
  }
  assert.match(backups, /index-cardinality\.csv/);
  assert.match(evidence, /backupPipelineSeconds/);
  assert.match(evidence, /measuredRtoSeconds/);
  assert.match(evidence, /evidence\.sha256[\s\S]*EVIDENCE_COMPLETE\.json/);
  assert.match(evidence, /DND_DR_EVIDENCE_ROOT[\s\S]*evidence_dir[\s\S]*\$project/);
  assert.match(evidence, /minisign -S[\s\S]*EVIDENCE_COMPLETE\.json/);
});

test("sensitive backup artifacts require encryption and unsafe variants are absent", () => {
  assert.match(createBackup, /command -v age/);
  assert.match(createBackup, /DND_BACKUP_PLAINTEXT_TMPDIR must be tmpfs/);
  assert.match(createBackup, /for artifact in nfs\.tar\.gz[\s\S]*postgres\.dump[\s\S]*source-fingerprints\.csv/);
  assert.match(backups, /mutually authenticated TLS 1\.2\+ or SSH\/SFTP/);
  assert.match(backups, /separate least-privilege accounts/);
  assert.match(backups, /separate replica-sealing role/);
  assert.match(backups, /Rotate recipients at least annually/);
  assert.match(backups, /Secure expiry deletes every replica/);
  assert.match(removePlaintext, /dr-target-guard\.sh" verify --project-name "\$project"/);
  assert.match(removePlaintext, /"\$path" = "\/run\/dnd-dr-tmpfs\/\$project"/);
  assert.doesNotMatch(bashBlocks(backups.slice(backups.indexOf("## Empty-environment restore drill"))).join("\n"), /\brm -rf\b/);
  assert.doesNotMatch(backups, /\bNFS_(?:SERVER|USERNAME|PASSWORD|CREDENTIALS?)\s*=/i);
  assert.doesNotMatch(backups, /\bnfs(?:4)?:\/\//i);
  assert.doesNotMatch(backups, /\.\/scripts\/production-up\.sh/);
  assert.doesNotMatch(backups, /docker compose[^\n]*(?:down|run|up|exec)/);
});
