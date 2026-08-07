#!/bin/sh
set -eu

load_secret() {
  variable="$1"
  file_variable="${variable}_FILE"
  eval "file=\${$file_variable:-}"
  [ -z "$file" ] && return
  [ -r "$file" ] || { echo "$file_variable is not readable" >&2; exit 1; }
  value=$(tr -d '\r\n' < "$file")
  export "$variable=$value"
  unset "$file_variable"
}

load_secret DATABASE_URL
load_secret REDIS_URL
load_secret AUTH_SECRET
load_secret ZAI_API_KEY
load_secret LLM_API_KEY

exec "$@"
