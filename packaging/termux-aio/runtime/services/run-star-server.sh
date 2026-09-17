#!/bin/bash
set -euo pipefail

# shellcheck disable=SC1091
source /opt/quasar-aio/state/secrets/runtime.env

wait_until() {
  local name="$1"
  shift
  for _ in $(seq 1 120); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'Timed out waiting for %s\n' "$name" >&2
  return 1
}

wait_until couchdb curl -fsS -u "admin:$COUCHDB_PASSWORD" http://127.0.0.1:5984/_up
wait_until rabbitmq rabbitmq-diagnostics -q ping
wait_until valkey env VALKEYCLI_AUTH="$VALKEY_PASSWORD" valkey-cli -h 127.0.0.1 -p 6379 ping

export COUCHDB_HOST=127.0.0.1
export COUCHDB_PORT=5984
export COUCHDB_USER=admin
export COUCHDB_PASSWORD
export RABBITMQ_ADDRESS=127.0.0.1
export RABBITMQ_PORT=5672
export RABBITMQ_USER=guest
export RABBITMQ_PASSWORD=guest
export HTTP_API_LISTEN_ADDRESS=127.0.0.1
export HTTP_API_PORT=5000
export STAR_AUTH_ALLOWED_ORIGINS=http://127.0.0.1:8080,http://localhost:8080
export STAR_AUTH_PEPPER
export STAR_AUTH_INITIAL_PASSWORD
export STAR_AUTH_DEV_BYPASS=true
export STAR_PUBLIC_MODE=true
export STAR_LEASE_STORE_BACKEND=valkey
export VALKEY_HOST=127.0.0.1
export VALKEY_PORT=6379
export VALKEY_PASSWORD_FILE=/opt/quasar-aio/state/secrets/valkey-password
export STAR_OBSERVABILITY_ENABLED=false

exec /opt/quasar-aio/runtime/bin/star-server \
  start \
  -i /opt/quasar-aio/runtime/star-server-init.lisp
