import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
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
const drComposeLib = await readFile(new URL("../../scripts/dr-compose-lib.sh", import.meta.url), "utf8");
const drDockerSocket = await readFile(new URL("../../scripts/dr-docker-socket.sh", import.meta.url), "utf8");
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
const chronology = await readFile(new URL("../../scripts/validate-backup-chronology.mjs", import.meta.url), "utf8");
const compose = parse(composeSource) as { services: Record<string, unknown>; volumes: Record<string, unknown> };

function bashBlocks(section = backups): string[] {
  return [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
}

async function listenOnUnixSocket(path: string): Promise<Server> {
  const server = createServer();
  server.listen(path);
  await once(server, "listening");
  await chmod(path, 0o600);
  return server;
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
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
    "scripts/dr-restore-nfs-archive.sh",
    "scripts/dr-remove-plaintext.sh",
    "scripts/seal-backup-replica.sh",
    "scripts/seal-dr-evidence.sh",
    "scripts/verify-backup-set.sh",
  ]) assert.ok(paths.has(expected), expected);
  for (const path of paths) await access(new URL(`../../${path}`, import.meta.url));
  for (const internal of [
    "scripts/dr-compose-lib.sh",
    "scripts/dr-docker-socket.sh",
    "scripts/dr-critical-fingerprint.sql",
    "scripts/dr-index-cardinality.sql",
    "scripts/dr-reconcile-ingestion.sql",
    "scripts/filesystem-access-model.mjs",
    "scripts/validate-backup-chronology.mjs",
  ]) await access(new URL(`../../${internal}`, import.meta.url));

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
  assert.match(drCompose, /validate-content\|start-postgres\|restore-postgres/);
  assert.doesNotMatch(drCompose, /"\$@"/);
  assert.match(drComposeLib, /--project-directory "\$dr_repo_root"/);
  assert.match(drComposeLib, /--env-file "\$dr_env_file"/);
  assert.match(drComposeLib, /--file "\$dr_compose_file"/);
  assert.match(drComposeLib, /unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROJECT_DIR COMPOSE_PROFILES/);
  assert.match(drDockerSocket, /DR_DOCKER_HOST:-unix:\/\/\/var\/run\/docker\.sock/);
  assert.match(drComposeLib, /dr_docker\(\)[\s\S]*env -u DOCKER_CONTEXT -u DOCKER_HOST DOCKER_HOST="\$dr_docker_host" docker "\$@"/);
  assert.match(drComposeLib, /dr_compose\(\)[\s\S]*dr_docker compose/);
  for (const script of [permissionsSmoke, replacementSmoke]) {
    assert.match(script, /"\$1" = "--project-name"/);
    assert.match(script, /dr-target-guard\.sh" verify --project-name "\$project"/);
    assert.match(script, /dr-compose-lib\.sh/);
    assert.match(script, /dr_compose_initialize "\$project"/);
  }
  assert.match(productionSmoke, /project="dnd94-dr-smoke-\$\$"/);
  assert.match(productionSmoke, /dr-compose\.sh --project-name "\$project" teardown/);
});

test("DR Compose rejects every config, project, profile, mount, build, and command escape before Docker", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "dnd-dr-compose-"));
  const data = join(temporary, "data");
  const marker = join(temporary, "target.marker");
  const bin = join(temporary, "bin");
  const dockerLog = join(temporary, "docker.log");
  const socket = join(temporary, "docker.sock");
  const socketServer = await listenOnUnixSocket(socket);
  await mkdir(data);
  await mkdir(bin);
  await writeFile(join(bin, "docker"), `#!/bin/sh\nenv > "${dockerLog}"\nprintf '%s\\n' "$@" >> "${dockerLog}"\n`);
  await chmod(join(bin, "docker"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DND_DATA_HOST_PATH: data,
    DND_DR_PRODUCTION_DATA_PATH: join(temporary, "production-data"),
    DND_DR_EMPTY_TARGET_MARKER: marker,
    DND_NFS_PREFLIGHT_TEST_MODE: "1",
    DND_DR_GUARD_TEST_MODE: "1",
    DND_DR_OPT_IN: "I_UNDERSTAND_DND_FIREGORY_DR_IS_DESTRUCTIVE",
    COMPOSE_FILE: "/tmp/evil.yml",
    COMPOSE_PROJECT_NAME: "production",
    COMPOSE_PROJECT_DIR: "/tmp",
    COMPOSE_PROFILES: "evil",
    COMPOSE_ENV_FILES: "/tmp/evil.env",
    DOCKER_HOST: "",
    DOCKER_CONTEXT: "",
    DR_DOCKER_HOST: `unix://${socket}`,
  };
  const run = (args: string[], runEnv = env) => spawnSync("sh", ["scripts/dr-compose.sh", "--project-name", "dnd94-dr-smoke-compose", ...args], {
    cwd: root,
    env: runEnv,
    encoding: "utf8",
  });
  const escapes = [
    ["--file", "/tmp/evil.yml", "status"], ["-f", "/tmp/evil.yml", "status"], ["--file=/tmp/evil.yml"], ["-f=/tmp/evil.yml"],
    ["--env-file", "/tmp/evil.env", "status"], ["--env-file=/tmp/evil.env"],
    ["--project-directory", "/tmp", "status"], ["--project-directory=/tmp"],
    ["--project-name", "production", "status"], ["--project-name=production"], ["-p", "production", "status"], ["-p=production"],
    ["--profile", "evil", "status"], ["--profile=evil"],
    ["status", "--file=/tmp/evil.yml"], ["start-stack", "--build"],
    ["validate-content", "--volume=/:/host"], ["validate-content", "-v", "/:/host"], ["validate-content", "-v=/:/host"],
    ["validate-content", "--mount", "type=bind,source=/,target=/host"], ["validate-content", "--mount=type=bind,source=/,target=/host"],
    ["validate-content", "--entrypoint", "sh"], ["validate-content", "--entrypoint=sh"],
    ["validate-content", "--env", "COMPOSE_FILE=/tmp/evil"], ["validate-content", "--env=COMPOSE_FILE=/tmp/evil"],
    ["validate-content", "--workdir=/prod"], ["validate-content", "--user=0"], ["validate-content", "--name=production"],
    ["validate-content", "--publish=5432:5432"], ["validate-content", "--pull=always"],
    ["run", "--build", "worker"], ["up", "--build"], ["config", "--volumes"],
    ["service-id", "app", "--volume=/prod:/data"], ["service-id", "../../production"],
  ];
  try {
    const initialized = spawnSync("sh", ["scripts/dr-target-guard.sh", "initialize", "--project-name", "dnd94-dr-smoke-compose"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    for (const escape of escapes) {
      await rm(dockerLog, { force: true });
      const result = run(escape);
      assert.equal(result.status, 2, `${escape.join(" ")}: ${result.stderr}`);
      await assert.rejects(access(dockerLog));
    }
    for (const remoteEnv of [
      { ...env, DOCKER_HOST: "tcp://production:2375" },
      { ...env, DOCKER_HOST: "ssh://production" },
      { ...env, DOCKER_HOST: `unix://${socket}` },
      { ...env, DOCKER_CONTEXT: "production" },
      { ...env, DR_DOCKER_HOST: "tcp://production:2375" },
      { ...env, DR_DOCKER_HOST: "ssh://production" },
      { ...env, DR_DOCKER_HOST: "context://production" },
    ]) {
      await rm(dockerLog, { force: true });
      assert.notEqual(run(["status"], remoteEnv).status, 0);
      await assert.rejects(access(dockerLog));
    }
    const regularFile = join(temporary, "not-a-socket");
    const socketLink = join(temporary, "socket-link");
    await writeFile(regularFile, "not a socket");
    await symlink(socket, socketLink);
    for (const endpoint of [regularFile, socketLink]) {
      await rm(dockerLog, { force: true });
      assert.notEqual(run(["status"], { ...env, DR_DOCKER_HOST: `unix://${endpoint}` }).status, 0);
      await assert.rejects(access(dockerLog));
    }
    await chmod(socket, 0o666);
    assert.notEqual(run(["status"]).status, 0);
    await assert.rejects(access(dockerLog));
    await chmod(socket, 0o600);
    const valid = run(["status"]);
    assert.equal(valid.status, 0, valid.stderr);
    const invocation = await readFile(dockerLog, "utf8");
    assert.match(invocation, new RegExp(`--project-directory\\n${String(root.pathname).replace(/\/$/, "")}`));
    assert.match(invocation, /--file\n.*compose\.production\.yml/);
    assert.doesNotMatch(invocation, /COMPOSE_FILE=|COMPOSE_PROJECT_NAME=|COMPOSE_PROJECT_DIR=|COMPOSE_PROFILES=|COMPOSE_ENV_FILES=/);
    assert.match(invocation, new RegExp(`DOCKER_HOST=unix://${socket.replaceAll("/", "\\/")}`));
    assert.doesNotMatch(invocation, /DOCKER_CONTEXT=/);

    await rm(dockerLog, { force: true });
    const inspect = spawnSync("sh", ["-c", ". ./scripts/dr-compose-lib.sh; dr_compose_initialize dnd94-dr-smoke-compose ./scripts; dr_docker inspect --format '{{.State.Status}}' container-id"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(inspect.status, 0, inspect.stderr);
    const inspectInvocation = await readFile(dockerLog, "utf8");
    assert.match(inspectInvocation, /inspect\n--format\n\{\{\.State\.Status\}\}\ncontainer-id/);
    assert.match(inspectInvocation, new RegExp(`DOCKER_HOST=unix://${socket.replaceAll("/", "\\/")}`));
    assert.doesNotMatch(inspectInvocation, /DOCKER_CONTEXT=/);
  } finally {
    await closeServer(socketServer);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("production smoke scripts route inspect and version calls through the validated Docker helper", () => {
  for (const script of [productionSmoke, replacementSmoke]) {
    assert.doesNotMatch(script, /\bdocker inspect\b|\bdocker compose version\b/);
    assert.match(script, /dr_docker inspect/);
    assert.match(script, /dr-compose-lib\.sh/);
    assert.match(script, /dr_compose_initialize "\$project"/);
  }
  assert.match(productionSmoke, /dr_docker compose version/);
});

test("DR target guard fails closed and binds an empty target to one project", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "dnd-dr-guard-"));
  const data = join(temporary, "data");
  const marker = join(temporary, "target.marker");
  const socket = join(temporary, "docker.sock");
  const socketServer = await listenOnUnixSocket(socket);
  await mkdir(data);
  const baseEnv = {
    ...process.env,
    DND_DATA_HOST_PATH: data,
    DND_DR_PRODUCTION_DATA_PATH: join(temporary, "production-data"),
    DND_DR_EMPTY_TARGET_MARKER: marker,
    DND_NFS_PREFLIGHT_TEST_MODE: "1",
    DND_DR_GUARD_TEST_MODE: "1",
    DOCKER_HOST: "",
    DOCKER_CONTEXT: "",
    DR_DOCKER_HOST: `unix://${socket}`,
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
    await closeServer(socketServer);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("marker directory is assigned to and verified against the invoking operator", () => {
  assert.match(backups, /sudo install -d -m 0700 -o "\$\(id -u\)" -g "\$\(id -g\)"/);
  assert.match(guard, /stat -c '%u'[\s\S]*"\$\(id -u\)"/);
  assert.match(guard, /DR marker parent must be owned by the invoking operator/);
  assert.match(guard, /DR marker parent must have mode 0700/);
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
  assert.match(guard, /docker_socket=%s[\s\S]*"\$dr_docker_socket"/);
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

test("backup chronology rejects reversed and future timestamps before COMPLETE", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "dnd-backup-time-"));
  const metadataPath = join(temporary, "metadata.json");
  const completePath = join(temporary, "COMPLETE.json");
  const timestamp = (offsetSeconds: number) => new Date(Math.floor(Date.now() / 1000) * 1000 + offsetSeconds * 1000).toISOString().replace(".000", "");
  const valid = {
    sourceSnapshotTime: timestamp(-80),
    backupStartedAt: timestamp(-70),
    nfsVerificationStarted: timestamp(-60),
    nfsVerificationFinished: timestamp(-50),
    postgresSnapshotExportedAt: timestamp(-40),
    postgresDumpStarted: timestamp(-30),
    postgresDumpFinished: timestamp(-20),
    backupGeneratedAt: timestamp(-10),
  };
  const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/validate-backup-chronology.mjs", metadataPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  try {
    await writeFile(metadataPath, JSON.stringify(valid));
    assert.equal(run().status, 0);
    await writeFile(completePath, JSON.stringify({ sourceSnapshotTime: valid.sourceSnapshotTime, replicationCompletedAt: timestamp(-5) }));
    assert.equal(run("--complete", completePath).status, 0);
    await writeFile(metadataPath, JSON.stringify({ ...valid, postgresDumpStarted: timestamp(-55) }));
    assert.notEqual(run().status, 0);
    await writeFile(metadataPath, JSON.stringify({ ...valid, nfsVerificationFinished: timestamp(600) }));
    assert.notEqual(run().status, 0);
    await writeFile(metadataPath, JSON.stringify(valid));
    assert.notEqual(run("--replication-time", timestamp(-90)).status, 0);
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
  assert.match(restoreNfs, /--same-permissions/);
  assert.match(restoreNfs, /single-identity-posix-mode-no-acl/);
  assert.match(restoreNfs, /"\$uid:\$gid" = "\$gateway_uid:\$gateway_gid"/);
  assert.match(restoreNfs, /config --format json/);
  assert.match(restoreNfs, /filesystem-access-model\.mjs" --validate/);
  assert.doesNotMatch(drillBlocks, /--same-owner|\bchown\b|--numeric-owner/);
  assert.match(backups, /provider\/server restores or clones/);
  assert.match(backups, /Do not recursively `chown`/);
});

test("archive fallback access model rejects multiple or mismatched identities", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "dnd-access-model-"));
  const model = join(temporary, "model.json");
  const run = (uid: string, gid: string) => spawnSync(process.execPath, ["scripts/filesystem-access-model.mjs", "--validate", model, uid, gid], {
    cwd: root,
    encoding: "utf8",
  });
  try {
    await writeFile(model, JSON.stringify({ schemaVersion: 1, identities: [{ uid: 10001, gid: 10001 }], hasExtendedAcl: false, hasExtendedXattr: false }));
    assert.equal(run("10001", "10001").status, 0);
    assert.notEqual(run("10002", "10001").status, 0);
    await writeFile(model, JSON.stringify({ schemaVersion: 1, identities: [{ uid: 10001, gid: 10001 }, { uid: 10002, gid: 10001 }], hasExtendedAcl: false, hasExtendedXattr: false }));
    assert.notEqual(run("10001", "10001").status, 0);
    await writeFile(model, JSON.stringify({ schemaVersion: 1, identities: [{ uid: 10001, gid: 10001 }], hasExtendedAcl: true, hasExtendedXattr: false }));
    assert.notEqual(run("10001", "10001").status, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("critical fingerprints use the same PostgreSQL snapshot and must match before reconciliation", () => {
  for (const table of ["users", "sessions", "search_events", "rag_events", "compendium_import_audit", "compendium_import_review_audit", "compendium_editor_audit", "ingestion_jobs"]) {
    assert.match(fingerprints, new RegExp(`'${table}'`));
  }
  assert.match(fingerprints, /bit_xor\(hashtextextended\(row_json, 0\)\)/);
  assert.match(fingerprints, /bit_xor\(hashtextextended\(row_json, 1\)\)/);
  assert.match(fingerprints, /sum\(hashtextextended\(row_json, 2\)::numeric\)/);
  assert.doesNotMatch(fingerprints, /string_agg/);
  assert.doesNotMatch(fingerprints, /ON COMMIT DROP/);
  assert.match(createBackup, /pg_export_snapshot/);
  assert.match(createBackup, /pg_dump[\s\S]*--snapshot "\$pg_snapshot"/);
  assert.match(createBackup, /SET TRANSACTION SNAPSHOT '\$pg_snapshot'/);
  const compare = backups.indexOf('cmp "$DR_EVIDENCE/source-fingerprints.csv"');
  const reconcileCommand = backups.indexOf("reconcile-ingestion");
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
  const validate = backups.indexOf("validate-content", drill);
  const reconcileStep = backups.indexOf("reconcile-ingestion", drill);
  const dryRun = backups.indexOf("index-clean-dry-run", drill);
  const clean = backups.indexOf("index-clean\n", drill);
  const acceptance = backups.indexOf("services_accepted", drill);
  assert.ok(checksum > drill && validate > checksum && reconcileStep > validate);
  assert.ok(dryRun > reconcileStep && clean > dryRun && acceptance > clean);
});

test("metadata and evidence make RPO/RTO and cardinality measurable", () => {
  for (const field of ["sourceSnapshotTime", "backupStartedAt", "nfsVerificationStarted", "nfsVerificationFinished", "postgresSnapshotExportedAt", "postgresDumpStarted", "postgresDumpFinished", "backupGeneratedAt"]) {
    assert.match(createBackup, new RegExp(field));
  }
  assert.match(sealReplica, /replicationCompletedAt/);
  assert.match(sealReplica, /validate-backup-chronology\.mjs[\s\S]*--replication-time/);
  assert.ok(sealReplica.indexOf("validate-backup-chronology.mjs") < sealReplica.indexOf("writeFileSync(`${directory}/COMPLETE.json`"));
  assert.match(verifyBackup, /validate-backup-chronology\.mjs[\s\S]*--complete/);
  assert.match(chronology, /futureLimit/);
  for (const event of ["drill_started", "nfs_restore_finished", "postgres_restore_finished", "index_rebuild_finished", "services_accepted"]) {
    assert.match(backups, new RegExp(event));
    assert.match(evidence, new RegExp(event));
  }
  assert.match(backups, /index-cardinality\.csv/);
  assert.match(evidence, /backupPipelineSeconds/);
  assert.match(evidence, /dockerSocket/);
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
  assert.match(backups, /DR_DOCKER_HOST=unix:\/\/\/run\/user\/1000\/docker\.sock/);
  assert.match(removePlaintext, /dr-target-guard\.sh" verify --project-name "\$project"/);
  assert.match(removePlaintext, /"\$path" = "\/run\/dnd-dr-tmpfs\/\$project"/);
  assert.doesNotMatch(bashBlocks(backups.slice(backups.indexOf("## Empty-environment restore drill"))).join("\n"), /\brm -rf\b/);
  assert.doesNotMatch(backups, /\bNFS_(?:SERVER|USERNAME|PASSWORD|CREDENTIALS?)\s*=/i);
  assert.doesNotMatch(backups, /\bnfs(?:4)?:\/\//i);
  assert.doesNotMatch(backups, /\.\/scripts\/production-up\.sh/);
  assert.doesNotMatch(backups, /docker compose[^\n]*(?:down|run|up|exec)/);
});
