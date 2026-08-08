#!/bin/sh
set -eu

[ "$#" -eq 4 ] && [ "$1" = "--project-name" ] && [ "$3" = "--archive" ] || {
  echo "Usage: $0 --project-name <dnd94-dr-name> --archive <absolute-tar.gz>" >&2
  exit 2
}
project=$2
archive=$4
case "$archive" in /*) ;; *) echo "Archive path must be absolute" >&2; exit 1 ;; esac
"$(dirname "$0")/dr-target-guard.sh" verify --project-name "$project" >/dev/null
[ -f "$archive" ] && [ ! -L "$archive" ] || { echo "Archive must be a regular non-symlink file" >&2; exit 1; }
[ -z "$(find "$DND_DATA_HOST_PATH" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
  echo "NFS archive restore requires the authorized target to remain empty" >&2
  exit 1
}
uid=${APP_UID:-10001}
gid=${APP_GID:-10001}
case "$uid:$gid" in *[!0-9:]*) echo "APP_UID and APP_GID must be numeric" >&2; exit 1 ;; esac

# The invoking shell opens the root-readable tmpfs archive; tar runs as the
# service identity seen by the root-squashed NFS server and never attempts chown.
sudo -u "#$uid" -g "#$gid" tar --extract --gzip --no-same-owner \
  --file - --directory "$DND_DATA_HOST_PATH" < "$archive"
