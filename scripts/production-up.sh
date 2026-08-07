#!/bin/sh
set -eu

if [ -z "${DND_DATA_HOST_PATH:-}" ] && [ -f .env ]; then
  while IFS='=' read -r name value; do
    if [ "$name" = DND_DATA_HOST_PATH ]; then
      case "$value" in
        \"*\") value=${value#\"}; value=${value%\"} ;;
        \'*\') value=${value#\'}; value=${value%\'} ;;
      esac
      export DND_DATA_HOST_PATH="$value"
      break
    fi
  done < .env
fi

"$(dirname "$0")/production-nfs-preflight.sh"
exec docker compose -f compose.production.yml up "$@"
