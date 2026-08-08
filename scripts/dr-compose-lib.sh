#!/bin/sh

dr_compose_initialize() {
  dr_project=$1
  dr_script_dir=$(CDPATH= cd -- "$2" && pwd -P)
  dr_repo_root=$(CDPATH= cd -- "$dr_script_dir/.." && pwd -P)
  dr_compose_file="$dr_repo_root/compose.production.yml"
  dr_env_file="$dr_repo_root/.env"
  [ -f "$dr_compose_file" ] || { echo "Canonical production Compose file is missing" >&2; exit 1; }
  [ -f "$dr_env_file" ] || { echo "Canonical repository .env is required" >&2; exit 1; }

  unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROJECT_DIR COMPOSE_PROFILES \
    COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR COMPOSE_IGNORE_ORPHANS \
    COMPOSE_PARALLEL_LIMIT COMPOSE_PROGRESS COMPOSE_MENU COMPOSE_EXPERIMENTAL COMPOSE_BAKE
}

dr_compose() {
  docker compose \
    --project-name "$dr_project" \
    --project-directory "$dr_repo_root" \
    --env-file "$dr_env_file" \
    --file "$dr_compose_file" \
    "$@"
}
