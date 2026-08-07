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
  worker: { target: "worker-production", user: "${APP_UID:-10001}:${APP_GID:-10001}", canonicalReadOnly: false },
  gateway: { target: "agent-gateway", user: "${GATEWAY_UID:-10001}:${GATEWAY_GID:-10001}", canonicalReadOnly: true },
};

for (const [name, contract] of Object.entries(expected)) {
  const service = services[name];
  check(service?.build?.target === contract.target, `${name} must build target ${contract.target}.`);
  check(service.user === contract.user, `${name} has an incompatible runtime identity.`);
  const canonical = service.volumes?.find((volume) => typeof volume === "object" && volume.source?.includes("DND_DATA_HOST_PATH"));
  check(canonical?.target === "${DND_DATA_ROOT:-/app/content-repository}", `${name} must mount the host NFS path at DND_DATA_ROOT.`);
  check(canonical.read_only === contract.canonicalReadOnly, `${name} canonical access has the wrong read-only mode.`);
  check(canonical.bind?.create_host_path === false, `${name} must not create a missing host canonical path.`);
}

const appUid = process.env.APP_UID ?? "10001";
const appGid = process.env.APP_GID ?? "10001";
check(!process.env.WORKER_UID || process.env.WORKER_UID === appUid, "WORKER_UID is incompatible with the shared app/worker spool identity.");
check(!process.env.WORKER_GID || process.env.WORKER_GID === appGid, "WORKER_GID is incompatible with the shared app/worker spool identity.");

for (const name of ["app", "worker", "gateway", "postgres", "redis"]) {
  const service = services[name];
  check(service?.healthcheck, `${name} must define a healthcheck.`);
}
for (const name of ["migrate", "app", "worker", "gateway", "postgres", "redis"]) {
  const service = services[name];
  check(service?.read_only === true, `${name} must use a read-only root filesystem.`);
  check(service?.cap_drop?.includes("ALL"), `${name} must drop all Linux capabilities.`);
  check(service?.pids_limit, `${name} must define a PID limit.`);
  check(service?.deploy?.resources?.limits, `${name} must define resource limits.`);
}

for (const name of ["app", "worker", "gateway"]) {
  check(services[name].depends_on?.migrate?.condition === "service_completed_successfully", `${name} must wait for successful migrations.`);
}
check(services.migrate.build.target === "migration-production", "migrate must use the one-shot migration image.");
check(services.app.ports.includes("${APP_BIND_ADDRESS:-127.0.0.1}:${APP_PORT:-3000}:3000"), "app must bind to loopback by default.");
check(services.gateway.ports.includes("${GATEWAY_BIND_ADDRESS:-127.0.0.1}:${AGENT_GATEWAY_PORT:-8787}:8787"), "gateway must bind to loopback by default.");
check(services.app.volumes.includes("upload_spool:/app/storage"), "app must use the local upload spool.");
check(services.worker.volumes.includes("upload_spool:/app/storage"), "worker must use the local upload spool.");
check(services.postgres.volumes.includes("postgres_data:/var/lib/postgresql/data"), "PostgreSQL data must use a local volume.");
check(services.redis.volumes.includes("redis_data:/data"), "Redis data must use a local volume.");
check(!services.postgres.ports && !services.redis.ports, "Production databases must not publish host ports.");
for (const volume of ["upload_spool", "postgres_data", "redis_data"]) {
  check(Object.hasOwn(config.volumes ?? {}, volume), `${volume} must be declared as a local volume.`);
}
check(services.postgres.image === "pgvector/pgvector:0.8.1-pg16", "PostgreSQL/pgvector image must be version-pinned.");
check(services.redis.build.target === "redis-production", "Redis must use the protected production target.");
check(!JSON.stringify(services.redis.healthcheck).includes("redis_password"), "Redis healthcheck must not read password material.");
check(!source.includes("requirepass"), "Redis password must not appear in process arguments.");

function rejectNfsProvisioning(value) {
  if (/\bdriver_opts:|\btype:\s*nfs|\baddr=|\bnfsvers=|\bNFS_(?:SERVER|USERNAME|PASSWORD|CREDENTIAL)/i.test(value)) {
    throw new Error("Production Compose must consume a preflighted host bind mount without NFS credentials.");
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
    APP_URL: process.env.APP_URL ?? "https://127.0.0.1",
    DND_DATA_HOST_PATH: process.env.DND_DATA_HOST_PATH || "/tmp/dnd-firegory-data",
  },
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
rejectNfsProvisioning(result.stdout);
console.log("Docker Compose production configuration is valid and contains no NFS provisioning material.");
