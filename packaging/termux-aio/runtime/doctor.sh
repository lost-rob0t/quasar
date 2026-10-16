#!/bin/bash
set -euo pipefail

quiet=0
if [[ "${1:-}" == "--quiet" ]]; then
  quiet=1
fi

# shellcheck disable=SC1091
source /opt/quasar-aio/state/secrets/runtime.env

ok=0
failures=0

check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    if [[ "$quiet" -eq 0 ]]; then
      printf '[ok]   %s\n' "$name"
    fi
    ok=$((ok + 1))
  else
    if [[ "$quiet" -eq 0 ]]; then
      printf '[fail] %s\n' "$name" >&2
    fi
    failures=$((failures + 1))
  fi
}

check couchdb curl -fsS -u "admin:$COUCHDB_PASSWORD" http://127.0.0.1:5984/_up
check rabbitmq rabbitmq-diagnostics -q ping
check valkey env VALKEYCLI_AUTH="$VALKEY_PASSWORD" valkey-cli -h 127.0.0.1 -p 6379 ping
check starintel-live curl -fsS http://127.0.0.1:5000/live
check starintel-ready curl -fsS http://127.0.0.1:5000/ready
check quasar-http curl -fsS http://127.0.0.1:8080/

if [[ "$quiet" -eq 0 ]]; then
  printf '\n%d checks passed; %d failed.\n' "$ok" "$failures"
  if [[ "$failures" -eq 0 ]]; then
    printf 'Quasar: http://127.0.0.1:8080\n'
  fi
fi

[[ "$failures" -eq 0 ]]
