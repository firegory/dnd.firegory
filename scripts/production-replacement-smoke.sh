#!/bin/sh
set -eu

[ "$#" -eq 2 ] && [ "$1" = "--project-name" ] || {
  echo "Usage: $0 --project-name <dnd94-dr-name>" >&2
  exit 2
}
project=$2
"$(dirname "$0")/dr-target-guard.sh" verify --project-name "$project" >/dev/null
compose() { docker compose --project-name "$project" --file compose.production.yml "$@"; }
marker="replacement-smoke-$$"

wait_healthy() {
  service="$1"
  attempts=0
  until [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$(compose ps -q "$service")")" = healthy ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 60 ] || { compose logs "$service"; return 1; }
    sleep 2
  done
}

compose exec -T worker sh -c 'printf canonical > "$DND_DATA_ROOT/'"$marker"'"'
compose exec -T app sh -c 'printf spool > "/app/storage/'"$marker"'"'
compose exec -T postgres psql -U "${POSTGRES_USER:-dnd}" -d "${POSTGRES_DB:-dnd_firegory}" -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE IF NOT EXISTS production_smoke (key text PRIMARY KEY); INSERT INTO production_smoke VALUES ('$marker') ON CONFLICT DO NOTHING;"
compose exec -T redis sh -ec 'export REDISCLI_AUTH="$(tr -d "\r\n" < /run/secrets/redis_password)"; redis-cli SET '"$marker"' persisted >/dev/null; redis-cli WAITAOF 1 0 5000 >/dev/null'

compose up -d --no-deps --force-recreate postgres redis
wait_healthy postgres
wait_healthy redis
compose up -d --no-deps --force-recreate migrate
attempts=0
until [ "$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "$(compose ps -a -q migrate)")" = exited:0 ]; do
  attempts=$((attempts + 1))
  [ "$attempts" -lt 60 ] || { compose logs migrate; exit 1; }
  sleep 1
done
compose up -d --no-deps --force-recreate app worker
wait_healthy app
wait_healthy worker

compose exec -T app sh -c 'test "$(cat "$DND_DATA_ROOT/'"$marker"'")" = canonical'
compose exec -T app sh -c 'test "$(cat "/app/storage/'"$marker"'")" = spool'
compose exec -T postgres psql -U "${POSTGRES_USER:-dnd}" -d "${POSTGRES_DB:-dnd_firegory}" -Atqc \
  "SELECT 1 FROM production_smoke WHERE key = '$marker'" | grep -qx 1
compose exec -T redis sh -ec 'export REDISCLI_AUTH="$(tr -d "\r\n" < /run/secrets/redis_password)"; test "$(redis-cli GET '"$marker"')" = persisted; test "$(redis-cli --raw CONFIG GET appendonly | tail -n 1)" = yes; test -f /data/appendonlydir/appendonly.aof.manifest'

compose exec -T worker sh -c 'rm "$DND_DATA_ROOT/'"$marker"'"'
compose exec -T app sh -c 'rm "/app/storage/'"$marker"'"'
echo "App, worker, PostgreSQL, and Redis replacement preserved canonical, spool, database, and AOF data."
