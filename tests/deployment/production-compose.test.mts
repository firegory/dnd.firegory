import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const compose = await readFile(new URL("../../compose.production.yml", import.meta.url), "utf8");
const developmentCompose = await readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
const nextConfig = await readFile(new URL("../../next.config.ts", import.meta.url), "utf8");
const dockerignore = await readFile(new URL("../../.dockerignore", import.meta.url), "utf8");
const entrypoint = await readFile(new URL("../../docker/entrypoint.prod.sh", import.meta.url), "utf8");
const redisEntrypoint = await readFile(new URL("../../docker/redis-entrypoint.sh", import.meta.url), "utf8");
const preflight = await readFile(new URL("../../scripts/production-nfs-preflight.sh", import.meta.url), "utf8");
const productionUp = await readFile(new URL("../../scripts/production-up.sh", import.meta.url), "utf8");
const permissionsSmoke = await readFile(new URL("../../scripts/production-permissions-smoke.sh", import.meta.url), "utf8");
const replacementSmoke = await readFile(new URL("../../scripts/production-replacement-smoke.sh", import.meta.url), "utf8");

type Volume = string | { source?: string; target?: string; read_only?: boolean; bind?: { create_host_path?: boolean } };
type Service = {
  build?: { target?: string };
  image?: string;
  user?: string;
  environment?: Record<string, string>;
  volumes?: Volume[];
  ports?: string[];
  healthcheck?: unknown;
  read_only?: boolean;
  cap_drop?: string[];
  pids_limit?: number;
  tmpfs?: string[];
  depends_on?: Record<string, { condition?: string }>;
  deploy?: { resources?: { limits?: unknown } };
};
const production = parse(compose, { merge: true }) as {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};

function canonicalMount(service: Service) {
  return service.volumes?.find((volume): volume is Exclude<Volume, string> => (
    typeof volume === "object" && volume.source?.includes("DND_DATA_HOST_PATH") === true
  ));
}

function dockerStage(name: string): { base: string; body: string } {
  const match = new RegExp(`^FROM ([^\\n]+) AS ${name}$`, "m").exec(dockerfile);
  assert.ok(match, `Docker stage ${name} is missing`);
  const remaining = dockerfile.slice(match.index + match[0].length);
  const nextStage = /^FROM /m.exec(remaining);
  return { base: match[1], body: remaining.slice(0, nextStage?.index) };
}

function finalUser(stage: string): string | undefined {
  return [...stage.matchAll(/^USER (.+)$/gm)].at(-1)?.[1];
}

test("production images are pinned, standalone, and use compatible identities", () => {
  assert.equal(production.services.app.build?.target, "app-production");
  assert.equal(production.services.worker.build?.target, "worker-production");
  assert.equal(production.services.gateway.build?.target, "agent-gateway");
  assert.equal(production.services.app.user, "${APP_UID:-10001}:${APP_GID:-10001}");
  assert.equal(production.services.worker.user, production.services.app.user);
  assert.equal(production.services.gateway.user, "${GATEWAY_UID:-10001}:${GATEWAY_GID:-10001}");
  assert.doesNotMatch(compose, /WORKER_(?:UID|GID)/);
  assert.match(dockerfile, /ARG NODE_IMAGE=node:\d+\.\d+\.\d+-bookworm-slim/);
  assert.match(dockerfile, /ARG REDIS_IMAGE=redis:7\.4\.5-alpine/);
  assert.equal(production.services.postgres.image, "pgvector/pgvector:0.8.1-pg16");
  assert.match(dockerfile, /\.next\/standalone/);
  assert.match(dockerfile, /CMD \["node", "server\.js"\]/);
});

test("production Docker stages preserve dependency and runtime boundaries", () => {
  assert.match(dockerfile, /^ARG NODE_IMAGE=node:\d+\.\d+\.\d+-bookworm-slim$/m);
  for (const name of ["agent-dependencies", "agent-gateway", "production-dependencies", "production-build", "production-base", "app-production"]) {
    assert.equal(dockerStage(name).base, "${NODE_IMAGE}");
  }
  assert.equal(dockerStage("migration-production").base, "production-base");
  assert.equal(dockerStage("worker-production").base, "production-base");

  const app = dockerStage("app-production").body;
  const worker = dockerStage("worker-production").body;
  const gateway = dockerStage("agent-gateway").body;
  assert.equal(finalUser(app), "10001:10001");
  assert.equal(finalUser(worker), "10001:10001");
  assert.equal(finalUser(gateway), "10001:10001");

  const productionDependencies = dockerStage("production-dependencies").body;
  const productionBase = dockerStage("production-base").body;
  const agentDependencies = dockerStage("agent-dependencies").body;
  assert.match(productionDependencies, /RUN npm ci --omit=dev/);
  assert.match(agentDependencies, /RUN npm ci --omit=dev/);
  assert.match(productionBase, /COPY --from=production-dependencies \/app\/node_modules \.\/node_modules/);
  assert.match(gateway, /COPY --from=agent-dependencies \/app\/node_modules \.\/node_modules/);
  assert.doesNotMatch(productionDependencies, /COPY \. \./);
  assert.doesNotMatch(agentDependencies, /COPY \. \./);

  assert.match(worker, /USER root[\s\S]*apt-get install[\s\S]*ocrmypdf[\s\S]*tesseract-ocr[\s\S]*USER 10001:10001/);
  assert.doesNotMatch(`${app}\n${gateway}`, /apt-get|ocrmypdf|tesseract-ocr/);

  assert.match(nextConfig, /output: "standalone"/);
  assert.match(app, /COPY --from=production-build --chown=10001:10001 \/app\/\.next\/standalone \.\//);
  assert.doesNotMatch(app, /npm ci|node_modules|COPY \. \./);
  assert.match(gateway, /COPY scripts\/agent-gateway\.mts scripts\/agent-healthcheck\.mts \.\/scripts\//);
  assert.match(gateway, /COPY src\/server\/agent \.\/src\/server\/agent/);
  assert.doesNotMatch(gateway, /COPY \. \.|COPY src \.\/src|npm ci/);
});

test("canonical host bind access is read-only except for the worker", () => {
  assert.deepEqual(canonicalMount(production.services.app), {
    type: "bind", source: "${DND_DATA_HOST_PATH:?Set DND_DATA_HOST_PATH to the active host NFS mount}", target: "${DND_DATA_ROOT:-/app/content-repository}", read_only: true, bind: { create_host_path: false },
  });
  assert.deepEqual(canonicalMount(production.services.gateway), {
    type: "bind", source: "${DND_DATA_HOST_PATH:?Set DND_DATA_HOST_PATH to the active host NFS mount}", target: "${DND_DATA_ROOT:-/app/content-repository}", read_only: true, bind: { create_host_path: false },
  });
  assert.equal(canonicalMount(production.services.worker)?.read_only, false);
  assert.doesNotMatch(compose, /driver_opts:|type:\s*nfs|addr=|nfsvers=|NFS_(?:SERVER|USERNAME|PASSWORD|CREDENTIAL)/i);
});

test("published HTTP ports default to loopback", () => {
  assert.deepEqual(production.services.app.ports, ["${APP_BIND_ADDRESS:-127.0.0.1}:${APP_PORT:-3000}:3000"]);
  assert.deepEqual(production.services.gateway.ports, ["${GATEWAY_BIND_ADDRESS:-127.0.0.1}:${AGENT_GATEWAY_PORT:-8787}:8787"]);
  assert.equal(production.services.postgres.ports, undefined);
  assert.equal(production.services.redis.ports, undefined);
});

test("one-shot migration gates every schema consumer", () => {
  assert.equal(production.services.migrate.build?.target, "migration-production");
  for (const name of ["app", "worker", "gateway"]) {
    assert.equal(production.services[name].depends_on?.migrate?.condition, "service_completed_successfully");
  }
});

test("all services have least-privilege runtime limits", () => {
  for (const service of Object.values(production.services)) {
    assert.equal(service.read_only, true);
    assert.ok(service.cap_drop?.includes("ALL"));
    assert.ok(service.pids_limit);
    assert.ok(service.deploy?.resources?.limits);
    assert.ok(service.tmpfs);
  }
  for (const name of ["app", "worker", "gateway", "postgres", "redis"]) {
    assert.ok(production.services[name].healthcheck);
  }
  assert.ok(production.services.app.volumes?.includes("upload_spool:/app/storage"));
  assert.ok(production.services.worker.volumes?.includes("upload_spool:/app/storage"));
  assert.deepEqual(Object.keys(production.volumes).sort(), ["postgres_data", "redis_data", "upload_spool"]);
});

test("Redis generates protected tmpfs configuration without password arguments", () => {
  assert.match(redisEntrypoint, /sha256sum/);
  assert.match(redisEntrypoint, /user healthcheck on nopass -@all \+ping/);
  assert.match(redisEntrypoint, /umask 077/);
  assert.doesNotMatch(compose, /requirepass|redis-cli[^\n]*redis_password/);
  assert.doesNotMatch(JSON.stringify(production.services.redis.healthcheck), /redis_password/);
});

test("NFS preflight fails closed and smoke bypass is explicit", () => {
  assert.match(preflight, /findmnt --noheadings --raw --output FSTYPE --target/);
  assert.match(preflight, /nfs\|nfs4/);
  assert.match(productionUp, /production-nfs-preflight\.sh[\s\S]*docker compose/);
  const missing = spawnSync("sh", ["scripts/production-nfs-preflight.sh"], { cwd: new URL("../..", import.meta.url) });
  assert.notEqual(missing.status, 0);
  const testMode = spawnSync("sh", ["scripts/production-nfs-preflight.sh"], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, DND_DATA_HOST_PATH: process.cwd(), DND_NFS_PREFLIGHT_TEST_MODE: "1" },
  });
  assert.equal(testMode.status, 0);
});

test("validator rejects an incompatible worker identity", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-production-compose.mjs"], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, APP_UID: "10001", WORKER_UID: "10002" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKER_UID is incompatible/);
});

test("secret handling and replacement smoke cover all persistent services", () => {
  assert.match(entrypoint, /export "\$variable=\$value"\s+unset "\$file_variable"/);
  assert.match(dockerignore, /^\.env\*$/m);
  assert.match(dockerignore, /^!\.env\.example$/m);
  assert.match(permissionsSmoke, /app_identity[\s\S]*worker_identity/);
  for (const service of ["app", "worker", "postgres", "redis"]) {
    assert.match(replacementSmoke, new RegExp(`force-recreate[^\\n]*${service}|force-recreate ${service}`));
  }
  assert.match(replacementSmoke, /WAITAOF/);
  assert.match(replacementSmoke, /appendonly\.aof\.manifest/);
});

test("development Compose remains the live-reload stack", () => {
  assert.match(developmentCompose, /target: dev/);
  assert.match(developmentCompose, /entrypoint: \["\.\/docker\/entrypoint\.dev\.sh"\]/);
  assert.match(developmentCompose, /- \.:\/app/);
  assert.doesNotMatch(developmentCompose, /app-production|worker-production|agent-gateway|migration-production/);
});
