import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backups = await readFile(new URL("../../docs/backups.md", import.meta.url), "utf8");
const compose = await readFile(new URL("../../compose.production.yml", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};
const indexCli = await readFile(new URL("../../scripts/content-index.mts", import.meta.url), "utf8");
const replacementSmoke = await readFile(new URL("../../scripts/production-replacement-smoke.sh", import.meta.url), "utf8");

test("backup runbook matches production storage paths and identities", () => {
  for (const value of [
    "DND_DATA_HOST_PATH=/mnt/dnd-firegory",
    "DND_DATA_ROOT=/app/content-repository",
    "APP_UID=10001",
    "APP_GID=10001",
    "postgres_data",
    "redis_data",
    "upload_spool",
  ]) {
    assert.match(backups, new RegExp(value.replaceAll("/", "\\/")));
    assert.match(compose, new RegExp(value.split("=")[0].replaceAll("/", "\\/")));
  }
  assert.match(compose, /user: "\$\{APP_UID:-10001\}:\$\{APP_GID:-10001\}"/);
});

test("backup runbook covers critical PostgreSQL state and derived boundaries", () => {
  for (const table of [
    "users",
    "sessions",
    "search_events",
    "rag_events",
    "compendium_import_audit",
    "compendium_import_review_audit",
    "compendium_editor_audit",
  ]) {
    assert.match(backups, new RegExp(`\\b${table}\\b`));
  }
  assert.match(backups, /Redis queue\/cache[\s\S]*Noncanonical/);
  assert.match(backups, /NFS-managed search index[\s\S]*Rebuildable/);
  assert.match(backups, /App, worker, gateway, migrate, Redis container filesystems[\s\S]*Replaceable/);
  assert.match(backups, /Site-loss RPO[\s\S]*2 hours/);
  assert.match(backups, /Service RTO[\s\S]*4 hours/);
});

test("documented migration, index, embedding, and replacement commands exist", () => {
  assert.equal(packageJson.scripts["production:config"], "node scripts/validate-production-compose.mjs");
  assert.match(backups, /\.\/scripts\/production-nfs-preflight\.sh/);
  assert.match(backups, /docker compose -f compose\.production\.yml/);
  assert.match(backups, /run --rm migrate/);
  for (const command of ["validate", "clean", "backfill-embeddings"]) {
    assert.match(backups, new RegExp(`scripts/content-index\\.mts ${command}|scripts/content-index\\.mts[\\s\\S]{0,80}${command}`));
    assert.match(indexCli, new RegExp(`\\b${command}\\b`));
  }
  assert.match(backups, /\.\/scripts\/production-replacement-smoke\.sh/);
  assert.match(replacementSmoke, /--force-recreate postgres redis/);
  assert.match(replacementSmoke, /--force-recreate app worker/);
});

test("restored checksums are verified before either index mutation", () => {
  const restore = backups.indexOf("## Empty-environment restore drill");
  const checksum = backups.indexOf('sha256sum --check "$BACKUP_DIR/nfs-files.sha256"', restore);
  const dryRun = backups.indexOf("scripts/content-index.mts clean --dry-run", restore);
  const clean = backups.indexOf("scripts/content-index.mts clean\n", restore);
  assert.ok(restore >= 0 && checksum > restore);
  assert.ok(dryRun > checksum);
  assert.ok(clean > checksum);
});

test("empty restore drill rejects existing project containers and volumes", () => {
  assert.match(backups, /compose\.production\.yml ps --all --quiet/);
  assert.match(backups, /docker volume ls --quiet --filter/);
  assert.match(backups, /label=com\.docker\.compose\.project=\$COMPOSE_PROJECT_NAME/);
});

test("runbook excludes NFS endpoints and credential material", () => {
  assert.doesNotMatch(backups, /\bNFS_(?:SERVER|USERNAME|PASSWORD|CREDENTIALS?)\s*=/i);
  assert.doesNotMatch(backups, /\bmount\s+(?:-t\s+nfs\S*\s+)?[^\n]*:/i);
  assert.doesNotMatch(backups, /\bnfs(?:4)?:\/\//i);
  assert.doesNotMatch(backups, /(?:username|password|keytab)\s*[:=]\s*[^<\s][^\n]*/i);
  assert.match(backups, /NFS access material belong[\s\S]*never in this repository/);
});

test("all documented Bash blocks are syntactically valid", () => {
  const blocks = [...backups.matchAll(/```bash\n([\s\S]*?)```/g)];
  assert.ok(blocks.length > 10);
  for (const [index, block] of blocks.entries()) {
    const result = spawnSync("bash", ["-n"], { input: block[1], encoding: "utf8" });
    assert.equal(result.status, 0, `Bash block ${index + 1}: ${result.stderr}`);
  }
});
