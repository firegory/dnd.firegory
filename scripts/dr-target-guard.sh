#!/bin/sh
set -eu

usage() {
  echo "Usage: $0 <initialize|verify|remove> --project-name <dnd94-dr-name>" >&2
  exit 2
}

[ "$#" -eq 3 ] || usage
action=$1
[ "$2" = "--project-name" ] || usage
project=$3

case "$action" in initialize|verify|remove) ;; *) usage ;; esac
case "$project" in dnd94-dr-?*) ;; *) echo "DR project must start with dnd94-dr-" >&2; exit 1 ;; esac
[ "${DND_NFS_PREFLIGHT_TEST_MODE:-0}" != 1 ] || {
  case "$project:${DND_DR_GUARD_TEST_MODE:-0}" in dnd94-dr-smoke-?*:1) ;;
    *) echo "NFS preflight test mode is restricted to guarded smoke projects" >&2; exit 1 ;;
  esac
}
[ "${DND_DR_OPT_IN:-}" = "I_UNDERSTAND_DND_FIREGORY_DR_IS_DESTRUCTIVE" ] || {
  echo "Set the documented DND_DR_OPT_IN value for this DR-only target" >&2
  exit 1
}

data_path=${DND_DATA_HOST_PATH:-}
marker=${DND_DR_EMPTY_TARGET_MARKER:-}
production_path=${DND_DR_PRODUCTION_DATA_PATH:-}
case "$data_path" in /*) ;; *) echo "DND_DATA_HOST_PATH must be absolute" >&2; exit 1 ;; esac
case "$marker" in /*) ;; *) echo "DND_DR_EMPTY_TARGET_MARKER must be absolute" >&2; exit 1 ;; esac
case "$production_path" in /*) ;; *) echo "DND_DR_PRODUCTION_DATA_PATH must be absolute" >&2; exit 1 ;; esac
[ -d "$data_path" ] || { echo "DR data path is not a directory: $data_path" >&2; exit 1; }
[ -d "$(dirname "$marker")" ] || { echo "DR marker parent does not exist" >&2; exit 1; }
[ "$(stat -c '%u' "$(dirname "$marker")")" = "$(id -u)" ] || {
  echo "DR marker parent must be owned by the invoking operator" >&2
  exit 1
}
[ "$(stat -c '%a' "$(dirname "$marker")")" = 700 ] || {
  echo "DR marker parent must have mode 0700" >&2
  exit 1
}

data_path=$(readlink -f "$data_path")
production_path=$(readlink -m "$production_path")
[ "$data_path" != "$production_path" ] || { echo "Refusing the configured production NFS path" >&2; exit 1; }
marker_parent=$(readlink -f "$(dirname "$marker")")
marker="$marker_parent/$(basename "$marker")"
case "$marker" in "$data_path"/*) echo "DR marker must be outside canonical data" >&2; exit 1 ;; esac

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
. "$script_dir/dr-docker-socket.sh"
dr_docker_socket_initialize
"$(dirname "$0")/production-nfs-preflight.sh" >/dev/null
mount_fingerprint=$(findmnt --noheadings --raw --output SOURCE,FSROOT,FSTYPE,OPTIONS --target "$data_path" | sha256sum | cut -d ' ' -f 1)

expected=$(printf 'dnd-firegory-dr-empty-target-v1\nproject=%s\ndata_path=%s\nmount_sha256=%s\ndocker_socket=%s\n' "$project" "$data_path" "$mount_fingerprint" "$dr_docker_socket")

verify_marker() {
  [ -f "$marker" ] && [ ! -L "$marker" ] || { echo "Expected DR empty-target marker is missing" >&2; exit 1; }
  [ "$(cat "$marker")" = "$expected" ] || { echo "DR marker does not match project and target" >&2; exit 1; }
  mode=$(stat -c '%a' "$marker")
  case "$mode" in 400|600) ;; *) echo "DR marker must have mode 0400 or 0600" >&2; exit 1 ;; esac
}

case "$action" in
  initialize)
    [ ! -e "$marker" ] || { echo "DR marker already exists" >&2; exit 1; }
    [ -z "$(find "$data_path" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
      echo "Refusing to authorize a non-empty DR target" >&2
      exit 1
    }
    umask 077
    temporary="$marker.tmp.$$"
    trap 'rm -f "$temporary"' EXIT INT TERM
    printf '%s\n' "$expected" > "$temporary"
    chmod 0600 "$temporary"
    mv "$temporary" "$marker"
    trap - EXIT INT TERM
    ;;
  verify)
    verify_marker
    ;;
  remove)
    verify_marker
    rm "$marker"
    ;;
esac

printf 'Validated DR-only project %s for %s.\n' "$project" "$data_path"
