#!/bin/sh
set -eu

[ "$#" -ge 3 ] && [ "$1" = "--project-name" ] || {
  echo "Usage: $0 --project-name <dnd94-dr-name> <compose arguments...>" >&2
  exit 2
}
project=$2
shift 2

for argument in "$@"; do
  case "$argument" in -p|--project-name|--project-name=*)
    echo "Nested Compose project overrides are forbidden" >&2
    exit 1
  esac
done

"$(dirname "$0")/dr-target-guard.sh" verify --project-name "$project" >/dev/null
exec docker compose --project-name "$project" --file compose.production.yml "$@"
