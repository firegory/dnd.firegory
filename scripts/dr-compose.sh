#!/bin/sh
set -eu

usage() {
  echo "Usage: $0 --project-name <dnd94-dr-name> <action>" >&2
  exit 2
}

[ "$#" -ge 3 ] && [ "$1" = "--project-name" ] || usage
project=$2
action=$3
shift 3

case "$action" in
  service-id|service-logs)
    [ "$#" -eq 1 ] || usage
    service=$1
    case "$service" in app|worker|gateway|migrate|postgres|redis) ;; *) usage ;; esac
    ;;
  validate-content|start-postgres|restore-postgres|fingerprint-postgres|migrate|reconcile-ingestion|index-clean-dry-run|index-clean|index-cardinality|start-stack|status|recreate-gateway|wait-stack|backfill-embeddings|teardown)
    [ "$#" -eq 0 ] || usage
    ;;
  *) usage ;;
esac

script_dir=$(dirname "$0")
"$script_dir/dr-target-guard.sh" verify --project-name "$project" >/dev/null
. "$script_dir/dr-compose-lib.sh"
dr_compose_initialize "$project" "$script_dir"

case "$action" in
  validate-content)
    dr_compose run --rm --no-deps worker node --experimental-strip-types scripts/content-index.mts validate
    ;;
  start-postgres)
    dr_compose up --detach --wait postgres
    ;;
  restore-postgres)
    dr_compose exec -T postgres pg_restore --username "${POSTGRES_USER:-dnd}" \
      --dbname "${POSTGRES_DB:-dnd_firegory}" --no-owner --no-acl --exit-on-error
    ;;
  fingerprint-postgres)
    dr_compose exec -T postgres psql --username "${POSTGRES_USER:-dnd}" \
      --dbname "${POSTGRES_DB:-dnd_firegory}" --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
      --file - < "$dr_repo_root/scripts/dr-critical-fingerprint.sql"
    ;;
  migrate)
    dr_compose run --rm migrate
    ;;
  reconcile-ingestion)
    dr_compose exec -T postgres psql --username "${POSTGRES_USER:-dnd}" \
      --dbname "${POSTGRES_DB:-dnd_firegory}" --no-psqlrc --set ON_ERROR_STOP=1 \
      --file - < "$dr_repo_root/scripts/dr-reconcile-ingestion.sql"
    ;;
  index-clean-dry-run)
    dr_compose run --rm --no-deps worker node --experimental-strip-types scripts/content-index.mts clean --dry-run
    ;;
  index-clean)
    dr_compose run --rm --no-deps worker node --experimental-strip-types scripts/content-index.mts clean
    ;;
  index-cardinality)
    dr_compose exec -T postgres psql --username "${POSTGRES_USER:-dnd}" \
      --dbname "${POSTGRES_DB:-dnd_firegory}" --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
      --csv --file - < "$dr_repo_root/scripts/dr-index-cardinality.sql"
    ;;
  start-stack)
    dr_compose up --detach --build
    ;;
  status)
    dr_compose ps --all
    ;;
  recreate-gateway)
    dr_compose up --detach --no-deps --force-recreate gateway
    ;;
  wait-stack)
    dr_compose up --detach --wait
    ;;
  backfill-embeddings)
    dr_compose run --rm --no-deps worker node --experimental-strip-types \
      scripts/content-index.mts backfill-embeddings --batch-size 20
    ;;
  teardown)
    dr_compose down --volumes --remove-orphans
    ;;
  service-id)
    dr_compose ps --all --quiet "$service"
    ;;
  service-logs)
    dr_compose logs "$service"
    ;;
esac
