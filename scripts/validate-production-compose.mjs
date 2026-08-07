import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const composePath = new URL("../compose.production.yml", import.meta.url);
const source = readFileSync(composePath, "utf8");
const config = parse(source, { merge: true });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

check(config && typeof config === "object", "Production Compose must be a YAML mapping.");
const services = config.services;
check(services && typeof services === "object", "Production Compose must define services.");

const expected = {
  app: { target: "app-production", user: "${APP_UID:-10001}:${APP_GID:-10001}", canonicalReadOnly: true },
  worker: { target: "worker-production", user: "${WORKER_UID:-10001}:${WORKER_GID:-10001}", canonicalReadOnly: false },
  gateway: { target: "agent-gateway", user: "${GATEWAY_UID:-10001}:${GATEWAY_GID:-10001}", canonicalReadOnly: true },
};

for (const [name, contract] of Object.entries(expected)) {
  const service = services[name];
  check(service?.build?.target === contract.target, `${name} must build target ${contract.target}.`);
  check(service.user === contract.user, `${name} must use its configurable non-root UID/GID.`);
  const canonical = service.volumes?.find((volume) => typeof volume === "object" && volume.source === "${DND_DATA_ROOT}");
  check(canonical?.target === "${DND_DATA_ROOT}", `${name} must bind DND_DATA_ROOT at the same absolute path.`);
  check(canonical.read_only === contract.canonicalReadOnly, `${name} canonical access has the wrong read-only mode.`);
}

for (const name of ["app", "worker", "gateway", "postgres", "redis"]) {
  const service = services[name];
  check(service?.healthcheck, `${name} must define a healthcheck.`);
  check(service?.deploy?.resources?.limits, `${name} must define resource limits.`);
}

check(services.app.volumes.includes("upload_spool:/app/storage"), "app must use the local upload spool.");
check(services.worker.volumes.includes("upload_spool:/app/storage"), "worker must use the local upload spool.");
check(services.postgres.volumes.includes("postgres_data:/var/lib/postgresql/data"), "PostgreSQL data must use a local volume.");
check(services.redis.volumes.includes("redis_data:/data"), "Redis data must use a local volume.");
check(!services.postgres.ports && !services.redis.ports, "Production databases must not publish host ports.");
for (const volume of ["upload_spool", "postgres_data", "redis_data"]) {
  check(Object.hasOwn(config.volumes ?? {}, volume), `${volume} must be declared as a local volume.`);
}
check(services.postgres.environment.POSTGRES_PASSWORD_FILE === "/run/secrets/postgres_password", "PostgreSQL must load its password from a secret file.");
check(services.gateway.environment.AGENT_GATEWAY_TOKENS_FILE === "/run/secrets/agent_token_policies", "Gateway policies must use a secret file.");

function rejectNfsProvisioning(value) {
  if (/\bdriver_opts:|\btype:\s*nfs|\baddr=|\bnfsvers=|\bNFS_(?:SERVER|USERNAME|PASSWORD|CREDENTIAL)/i.test(value)) {
    throw new Error("Production Compose must consume a host bind mount without NFS server or credential configuration.");
  }
}

rejectNfsProvisioning(source);

const docker = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
if (docker.status !== 0) {
  console.log("Docker unavailable; parsed YAML and static production contract validation passed.");
  process.exit(0);
}

const result = spawnSync("docker", ["compose", "-f", "compose.production.yml", "config"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  env: {
    ...process.env,
    APP_URL: process.env.APP_URL ?? "http://127.0.0.1:3000",
    DND_DATA_ROOT: process.env.DND_DATA_ROOT || "/tmp/dnd-firegory-data",
  },
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
rejectNfsProvisioning(result.stdout);
console.log("Docker Compose production configuration is valid and contains no NFS provisioning material.");
