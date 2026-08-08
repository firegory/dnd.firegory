#!/bin/sh
set -eu

command -v docker >/dev/null 2>&1 || { echo "Docker is required for the runtime smoke test." >&2; exit 1; }
docker compose version >/dev/null

root=$(mktemp -d)
project="dnd94-dr-smoke-$$"
export DND_DR_EMPTY_TARGET_MARKER="$root/empty-target.marker"
export DND_DR_OPT_IN=I_UNDERSTAND_DND_FIREGORY_DR_IS_DESTRUCTIVE
export DND_DR_GUARD_TEST_MODE=1
cleanup() {
  if [ -f "$DND_DR_EMPTY_TARGET_MARKER" ]; then
    ./scripts/dr-compose.sh --project-name "$project" teardown >/dev/null 2>&1 || true
    ./scripts/dr-target-guard.sh remove --project-name "$project" >/dev/null 2>&1 || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT INT TERM

mkdir -p "$root/data" "$root/secrets"
chmod 0777 "$root/data"
printf '%s\n' 'smoke-password' > "$root/secrets/postgres-password"
printf '%s\n' 'smoke-redis-password' > "$root/secrets/redis-password"
printf '%s\n' 'postgresql://dnd:smoke-password@postgres:5432/dnd_firegory' > "$root/secrets/database-url"
printf '%s\n' 'redis://:smoke-redis-password@redis:6379' > "$root/secrets/redis-url"
printf '%s\n' 'smoke-auth-secret-with-at-least-32-bytes' > "$root/secrets/auth-secret"
printf '\n' > "$root/secrets/zai-api-key"
printf '\n' > "$root/secrets/llm-api-key"
printf '%s\n' '[]' > "$root/secrets/agent-token-policies.json"
printf '%s\n' 'smoke-cursor-key-with-at-least-32-bytes' > "$root/secrets/agent-cursor-key"

uid=$(id -u)
gid=$(id -g)
if [ "$uid" -eq 0 ]; then uid=10001; fi
if [ "$gid" -eq 0 ]; then gid=10001; fi
export APP_URL=http://127.0.0.1:3000
export APP_PORT=0 AGENT_GATEWAY_PORT=0
export DND_DATA_HOST_PATH="$root/data" DND_DATA_ROOT=/app/content-repository
export DND_DR_PRODUCTION_DATA_PATH="$root/production-data"
export PRODUCTION_SECRETS_ROOT="$root/secrets" DND_NFS_PREFLIGHT_TEST_MODE=1
export APP_UID="$uid" APP_GID="$gid" GATEWAY_UID="$uid" GATEWAY_GID="$gid"

./scripts/dr-target-guard.sh initialize --project-name "$project"
./scripts/dr-compose.sh --project-name "$project" start-stack

for service in app worker gateway postgres redis; do
  attempts=0
  until [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$(./scripts/dr-compose.sh --project-name "$project" service-id "$service")")" = healthy ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      ./scripts/dr-compose.sh --project-name "$project" status
      ./scripts/dr-compose.sh --project-name "$project" service-logs "$service"
      echo "$service did not become healthy" >&2
      exit 1
    fi
    sleep 2
  done
done
test "$(docker inspect --format '{{.State.ExitCode}}' "$(./scripts/dr-compose.sh --project-name "$project" service-id migrate)")" = 0

./scripts/production-permissions-smoke.sh --project-name "$project"
./scripts/production-replacement-smoke.sh --project-name "$project"
echo "Production stack health and persistence smoke tests passed."
