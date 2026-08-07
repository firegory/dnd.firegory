#!/bin/sh
set -eu

command -v docker >/dev/null 2>&1 || { echo "Docker is required for the runtime smoke test." >&2; exit 1; }
docker compose version >/dev/null

root=$(mktemp -d)
project="dnd85smoke$$"
cleanup() {
  docker compose -f compose.production.yml -p "$project" down -v --remove-orphans >/dev/null 2>&1 || true
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
export DND_DATA_ROOT="$root/data" PRODUCTION_SECRETS_ROOT="$root/secrets"
export APP_UID="$uid" APP_GID="$gid" WORKER_UID="$uid" WORKER_GID="$gid" GATEWAY_UID="$uid" GATEWAY_GID="$gid"
export COMPOSE_PROJECT_NAME="$project"

compose="docker compose -f compose.production.yml"
$compose up -d --build postgres redis
$compose run --rm app npm run db:migrate
$compose up -d --build

for service in app worker gateway postgres redis; do
  attempts=0
  until [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$($compose ps -q "$service")")" = healthy ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      $compose ps
      $compose logs "$service"
      echo "$service did not become healthy" >&2
      exit 1
    fi
    sleep 2
  done
done

./scripts/production-permissions-smoke.sh
./scripts/production-replacement-smoke.sh
echo "Production stack health and persistence smoke tests passed."
