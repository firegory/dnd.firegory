#!/bin/sh
set -eu

secret=/run/secrets/redis_password
[ -r "$secret" ] || { echo "redis_password secret is not readable" >&2; exit 1; }
password=$(tr -d '\r\n' < "$secret")
[ -n "$password" ] || { echo "redis_password secret must not be empty" >&2; exit 1; }
password_hash=$(printf '%s' "$password" | sha256sum)
password_hash=${password_hash%% *}

umask 077
cat > /run/redis/users.acl <<EOF
user default on #$password_hash ~* &* +@all
user healthcheck on nopass -@all +ping
EOF
cat > /run/redis/redis.conf <<'EOF'
bind 0.0.0.0
protected-mode yes
appendonly yes
appendfsync everysec
dir /data
aclfile /run/redis/users.acl
EOF
unset password password_hash

exec "$@"
