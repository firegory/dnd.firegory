#!/bin/sh
set -eu

path=${DND_DATA_HOST_PATH:-}
[ -n "$path" ] || { echo "DND_DATA_HOST_PATH is required" >&2; exit 1; }
case "$path" in
  /*) ;;
  *) echo "DND_DATA_HOST_PATH must be absolute" >&2; exit 1 ;;
esac
[ -d "$path" ] || { echo "DND_DATA_HOST_PATH is not a directory: $path" >&2; exit 1; }

if [ "${DND_NFS_PREFLIGHT_TEST_MODE:-0}" = 1 ]; then
  echo "WARNING: NFS preflight test mode accepted $path; never use test mode in production." >&2
  exit 0
fi

command -v findmnt >/dev/null 2>&1 || { echo "findmnt is required to verify the host NFS mount" >&2; exit 1; }
filesystem=$(findmnt --noheadings --raw --output FSTYPE --target "$path" 2>/dev/null) || {
  echo "DND_DATA_HOST_PATH is not on an active mount: $path" >&2
  exit 1
}
case "$filesystem" in
  nfs|nfs4) ;;
  *) echo "DND_DATA_HOST_PATH must be on active nfs/nfs4, found: $filesystem" >&2; exit 1 ;;
esac

echo "Verified active $filesystem mount for $path."
