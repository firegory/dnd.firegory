#!/bin/sh
set -eu

compose="docker compose -f compose.production.yml"
marker="replacement-smoke-$$"

$compose exec -T worker sh -c 'printf canonical > "$DND_DATA_ROOT/'"$marker"'"'
$compose exec -T app sh -c 'printf spool > "/app/storage/'"$marker"'"'
$compose exec -T postgres psql -U "${POSTGRES_USER:-dnd}" -d "${POSTGRES_DB:-dnd_firegory}" -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE IF NOT EXISTS production_smoke (key text PRIMARY KEY); INSERT INTO production_smoke VALUES ('$marker') ON CONFLICT DO NOTHING;"
$compose exec -T redis sh -ec 'redis-cli --no-auth-warning -a "$(tr -d "\r\n" < /run/secrets/redis_password)" SET '"$marker"' persisted >/dev/null'

$compose up -d --no-deps --force-recreate app

$compose exec -T app sh -c 'test "$(cat "$DND_DATA_ROOT/'"$marker"'")" = canonical'
$compose exec -T app sh -c 'test "$(cat "/app/storage/'"$marker"'")" = spool'
$compose exec -T postgres psql -U "${POSTGRES_USER:-dnd}" -d "${POSTGRES_DB:-dnd_firegory}" -Atqc \
  "SELECT 1 FROM production_smoke WHERE key = '$marker'" | grep -qx 1
$compose exec -T redis sh -ec 'test "$(redis-cli --no-auth-warning -a "$(tr -d "\r\n" < /run/secrets/redis_password)" GET '"$marker"')" = persisted'

$compose exec -T worker sh -c 'rm "$DND_DATA_ROOT/'"$marker"'"'
$compose exec -T app sh -c 'rm "/app/storage/'"$marker"'"'
echo "App replacement preserved canonical, spool, PostgreSQL, and Redis data."
