#!/bin/sh

dr_docker_socket_initialize() {
  [ -z "${DOCKER_HOST:-}" ] || { echo "Ambient DOCKER_HOST is forbidden; use DR_DOCKER_HOST" >&2; exit 1; }
  [ -z "${DOCKER_CONTEXT:-}" ] || { echo "Ambient DOCKER_CONTEXT is forbidden" >&2; exit 1; }

  configured=${DR_DOCKER_HOST:-unix:///var/run/docker.sock}
  case "$configured" in
    unix:///*) socket_path=${configured#unix://} ;;
    *) echo "DR_DOCKER_HOST must be an absolute local unix:// socket" >&2; exit 1 ;;
  esac
  case "$socket_path" in /*) ;; *) echo "Docker socket path must be absolute" >&2; exit 1 ;; esac
  [ ! -L "$socket_path" ] || { echo "Docker socket must not be a symlink" >&2; exit 1; }
  [ -S "$socket_path" ] || { echo "Docker endpoint is not a Unix socket: $socket_path" >&2; exit 1; }
  dr_docker_socket=$(readlink -f "$socket_path")
  [ -S "$dr_docker_socket" ] || { echo "Canonical Docker endpoint is not a Unix socket" >&2; exit 1; }
  [ -r "$dr_docker_socket" ] && [ -w "$dr_docker_socket" ] || {
    echo "Docker socket is not readable and writable by the invoking operator" >&2
    exit 1
  }
  owner=$(stat -c '%u' "$dr_docker_socket")
  [ "$owner" = 0 ] || [ "$owner" = "$(id -u)" ] || {
    echo "Docker socket must be owned by root or the invoking rootless operator" >&2
    exit 1
  }
  mode=$(stat -c '%a' "$dr_docker_socket")
  world_digit=$((mode % 10))
  case "$world_digit" in 2|3|6|7) echo "Docker socket must not be world-writable" >&2; exit 1 ;; esac

  dr_docker_host="unix://$dr_docker_socket"
  unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
}
