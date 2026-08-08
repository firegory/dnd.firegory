#!/bin/sh
set -eu

[ "$#" -eq 2 ] && [ "$1" = "--project-name" ] || {
  echo "Usage: $0 --project-name <dnd94-dr-name>" >&2
  exit 2
}
project=$2
"$(dirname "$0")/dr-target-guard.sh" verify --project-name "$project" >/dev/null
compose() { docker compose --project-name "$project" --file compose.production.yml "$@"; }
marker=".permissions-smoke-$$"

app_identity=$(compose exec -T app sh -c 'printf "%s:%s" "$(id -u)" "$(id -g)"')
worker_identity=$(compose exec -T worker sh -c 'printf "%s:%s" "$(id -u)" "$(id -g)"')
test "$app_identity" = "$worker_identity" || {
  echo "app and worker must share the upload spool identity" >&2
  exit 1
}

if compose exec -T app sh -c 'touch "$DND_DATA_ROOT/'"$marker"'"' 2>/dev/null; then
  echo "app unexpectedly wrote to canonical storage" >&2
  exit 1
fi
if compose exec -T gateway sh -c 'touch "$DND_DATA_ROOT/'"$marker"'"' 2>/dev/null; then
  echo "gateway unexpectedly wrote to canonical storage" >&2
  exit 1
fi
compose exec -T worker sh -c 'touch "$DND_DATA_ROOT/'"$marker"'"'
compose exec -T app sh -c 'test -r "$DND_DATA_ROOT/'"$marker"'"'
compose exec -T worker sh -c 'rm "$DND_DATA_ROOT/'"$marker"'"'
compose exec -T app sh -c 'printf app > "/app/storage/'"$marker"'"'
compose exec -T worker sh -c 'printf worker >> "/app/storage/$1" && rm "/app/storage/$1"' sh "$marker"

echo "Canonical mount permissions passed (app/gateway RO, worker RW)."
