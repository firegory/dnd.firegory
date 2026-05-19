#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="postgresql://${POSTGRES_USER:-dnd}:${POSTGRES_PASSWORD:-dnd_dev_password}@postgres:5432/${POSTGRES_DB:-dnd_firegory}"
fi

exec "$@"
