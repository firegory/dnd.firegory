#!/bin/sh
set -eu

[ "$#" -eq 4 ] && [ "$1" = "--project-name" ] && [ "$3" = "--path" ] || {
  echo "Usage: $0 --project-name <dnd94-dr-name> --path /run/dnd-dr-tmpfs/<project>" >&2
  exit 2
}
project=$2
path=$4
"$(dirname "$0")/dr-target-guard.sh" verify --project-name "$project" >/dev/null
[ "$path" = "/run/dnd-dr-tmpfs/$project" ] || { echo "Plaintext path must exactly match the DR project" >&2; exit 1; }
[ -d "$path" ] && [ ! -L "$path" ] || { echo "Plaintext path must be a non-symlink directory" >&2; exit 1; }
[ "$(findmnt --noheadings --raw --output FSTYPE --target "$path")" = tmpfs ] || {
  echo "Refusing to remove a plaintext path outside tmpfs" >&2
  exit 1
}
rm -rf -- "$path"
