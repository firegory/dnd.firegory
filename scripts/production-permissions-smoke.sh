#!/bin/sh
set -eu

compose="docker compose -f compose.production.yml"
marker=".permissions-smoke-$$"

app_identity=$($compose exec -T app sh -c 'printf "%s:%s" "$(id -u)" "$(id -g)"')
worker_identity=$($compose exec -T worker sh -c 'printf "%s:%s" "$(id -u)" "$(id -g)"')
test "$app_identity" = "$worker_identity" || {
  echo "app and worker must share the upload spool identity" >&2
  exit 1
}

if $compose exec -T app sh -c 'touch "$DND_DATA_ROOT/'"$marker"'"' 2>/dev/null; then
  echo "app unexpectedly wrote to canonical storage" >&2
  exit 1
fi
if $compose exec -T gateway sh -c 'touch "$DND_DATA_ROOT/'"$marker"'"' 2>/dev/null; then
  echo "gateway unexpectedly wrote to canonical storage" >&2
  exit 1
fi
$compose exec -T worker sh -c 'touch "$DND_DATA_ROOT/'"$marker"'"'
$compose exec -T app sh -c 'test -r "$DND_DATA_ROOT/'"$marker"'"'
$compose exec -T worker sh -c 'rm "$DND_DATA_ROOT/'"$marker"'"'
$compose exec -T app sh -c 'printf app > "/app/storage/'"$marker"'"'
$compose exec -T worker sh -c 'printf worker >> "/app/storage/'"$marker"'" && rm "/app/storage/'"$marker"'"'

echo "Canonical mount permissions passed (app/gateway RO, worker RW)."
