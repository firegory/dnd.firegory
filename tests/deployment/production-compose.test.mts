import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const compose = await readFile(new URL("../../compose.production.yml", import.meta.url), "utf8");
const developmentCompose = await readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
const dockerignore = await readFile(new URL("../../.dockerignore", import.meta.url), "utf8");
const entrypoint = await readFile(new URL("../../docker/entrypoint.prod.sh", import.meta.url), "utf8");
const permissionsSmoke = await readFile(new URL("../../scripts/production-permissions-smoke.sh", import.meta.url), "utf8");
const replacementSmoke = await readFile(new URL("../../scripts/production-replacement-smoke.sh", import.meta.url), "utf8");

type Volume = string | { source?: string; target?: string; read_only?: boolean };
type Service = {
  build?: { target?: string };
  user?: string;
  environment?: Record<string, string>;
  volumes?: Volume[];
  healthcheck?: unknown;
  deploy?: { resources?: { limits?: unknown } };
  ports?: unknown;
};
const production = parse(compose, { merge: true }) as {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};

function canonicalMount(service: Service) {
  return service.volumes?.find((volume): volume is Exclude<Volume, string> => (
    typeof volume === "object" && volume.source === "${DND_DATA_ROOT}"
  ));
}

test("production YAML parses and services use non-root production targets", () => {
  assert.equal(production.services.app.build?.target, "app-production");
  assert.equal(production.services.worker.build?.target, "worker-production");
  assert.equal(production.services.gateway.build?.target, "agent-gateway");
  assert.equal(production.services.app.user, "${APP_UID:-10001}:${APP_GID:-10001}");
  assert.equal(production.services.worker.user, "${WORKER_UID:-10001}:${WORKER_GID:-10001}");
  assert.equal(production.services.gateway.user, "${GATEWAY_UID:-10001}:${GATEWAY_GID:-10001}");
  assert.match(dockerfile, /FROM production-base AS app-production/);
  assert.match(dockerfile, /FROM production-base AS worker-production/);
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS agent-gateway/);
});

test("canonical bind access is read-only except for the worker", () => {
  assert.deepEqual(canonicalMount(production.services.app), {
    type: "bind", source: "${DND_DATA_ROOT}", target: "${DND_DATA_ROOT}", read_only: true,
  });
  assert.deepEqual(canonicalMount(production.services.gateway), {
    type: "bind", source: "${DND_DATA_ROOT}", target: "${DND_DATA_ROOT}", read_only: true,
  });
  assert.deepEqual(canonicalMount(production.services.worker), {
    type: "bind", source: "${DND_DATA_ROOT}", target: "${DND_DATA_ROOT}", read_only: false,
  });
  assert.doesNotMatch(compose, /driver_opts:|type:\s*nfs|addr=|nfsvers=|NFS_(?:SERVER|USERNAME|PASSWORD|CREDENTIAL)/i);
});

test("production persistence, health, secrets, and limits are explicit", () => {
  assert.ok(production.services.app.volumes?.includes("upload_spool:/app/storage"));
  assert.ok(production.services.worker.volumes?.includes("upload_spool:/app/storage"));
  assert.ok(production.services.postgres.volumes?.includes("postgres_data:/var/lib/postgresql/data"));
  assert.ok(production.services.redis.volumes?.includes("redis_data:/data"));
  assert.deepEqual(Object.keys(production.volumes).sort(), ["postgres_data", "redis_data", "upload_spool"]);
  assert.equal(production.services.postgres.ports, undefined);
  assert.equal(production.services.redis.ports, undefined);
  for (const service of Object.values(production.services)) {
    assert.ok(service.healthcheck);
    assert.ok(service.deploy?.resources?.limits);
  }
  assert.equal(production.services.postgres.environment?.POSTGRES_PASSWORD_FILE, "/run/secrets/postgres_password");
  assert.equal(production.services.gateway.environment?.AGENT_GATEWAY_TOKENS_FILE, "/run/secrets/agent_token_policies");
});

test("secret-file entrypoint remains compatible with gateway configuration", () => {
  assert.match(entrypoint, /export "\$variable=\$value"\s+unset "\$file_variable"/);
  assert.match(dockerignore, /^secrets$/m);
});

test("smoke scripts prove canonical permissions and replacement persistence", () => {
  assert.match(permissionsSmoke, /exec -T app[\s\S]*unexpectedly wrote/);
  assert.match(permissionsSmoke, /exec -T gateway[\s\S]*unexpectedly wrote/);
  assert.match(permissionsSmoke, /exec -T worker sh -c 'touch/);
  assert.match(replacementSmoke, /--force-recreate app/);
  for (const marker of ["canonical", "spool", "production_smoke", "redis-cli"]) {
    assert.ok(replacementSmoke.includes(marker));
  }
});

test("development Compose remains the live-reload stack", () => {
  assert.match(developmentCompose, /target: dev/);
  assert.match(developmentCompose, /entrypoint: \["\.\/docker\/entrypoint\.dev\.sh"\]/);
  assert.match(developmentCompose, /- \.:\/app/);
  assert.doesNotMatch(developmentCompose, /app-production|worker-production|agent-gateway/);
});
