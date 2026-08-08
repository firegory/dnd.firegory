#!/bin/sh
set -eu

[ "$#" -eq 6 ] && [ "$1" = "--project-name" ] && [ "$3" = "--archive" ] && [ "$5" = "--access-model" ] || {
  echo "Usage: $0 --project-name <dnd94-dr-name> --archive <absolute-tar.gz> --access-model <absolute-json>" >&2
  exit 2
}
project=$2
archive=$4
access_model=$6
case "$archive:$access_model" in /*:/*) ;; *) echo "Archive and access-model paths must be absolute" >&2; exit 1 ;; esac
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
"$script_dir/dr-target-guard.sh" verify --project-name "$project" >/dev/null
[ -f "$archive" ] && [ ! -L "$archive" ] || { echo "Archive must be a regular non-symlink file" >&2; exit 1; }
[ -f "$access_model" ] && [ ! -L "$access_model" ] || { echo "Access model must be a regular non-symlink file" >&2; exit 1; }
[ "${DND_DR_ARCHIVE_FALLBACK_ACCESS_MODEL:-}" = "single-identity-posix-mode-no-acl" ] || {
  echo "Archive fallback requires an explicit single-identity/no-ACL assertion" >&2
  exit 1
}
[ -z "$(find "$DND_DATA_HOST_PATH" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
  echo "NFS archive restore requires the authorized target to remain empty" >&2
  exit 1
}
uid=${APP_UID:-10001}
gid=${APP_GID:-10001}
gateway_uid=${GATEWAY_UID:-10001}
gateway_gid=${GATEWAY_GID:-10001}
case "$uid:$gid:$gateway_uid:$gateway_gid" in *[!0-9:]*) echo "Service UIDs and GIDs must be numeric" >&2; exit 1 ;; esac
[ "$uid:$gid" = "$gateway_uid:$gateway_gid" ] || {
  echo "Archive fallback cannot reproduce a multi-identity app/gateway access model; use provider restore" >&2
  exit 1
}

. "$script_dir/dr-compose-lib.sh"
dr_compose_initialize "$project" "$script_dir"
effective=$(dr_compose config --format json)
printf '%s' "$effective" | node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const config = JSON.parse(readFileSync(0, "utf8"));
  const expected = process.argv[1];
  for (const service of ["app", "worker", "gateway"]) {
    if (config.services?.[service]?.user !== expected) throw new Error(`${service} effective identity is not ${expected}`);
  }
' "$uid:$gid"
node "$script_dir/filesystem-access-model.mjs" --validate "$access_model" "$uid" "$gid"

# The invoking shell opens the root-readable tmpfs archive; tar runs as the
# single service identity seen by root-squashed NFS. POSIX modes are restored;
# ACLs, xattrs, and multiple identities are deliberately unsupported here.
sudo -u "#$uid" -g "#$gid" tar --extract --gzip --no-same-owner --same-permissions \
  --file - --directory "$DND_DATA_HOST_PATH" < "$archive"
