#!/bin/bash
set -euo pipefail

for _ in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:5000/ready >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS http://127.0.0.1:5000/ready >/dev/null

export QUASAR_HOST=127.0.0.1
export QUASAR_HTTP_PORT=8080
export QUASAR_WS_PORT=8081
export QUASAR_STORAGE_PATH=/opt/quasar-aio/state/quasar/tek9
export QUASAR_INIT_FILE=/opt/quasar-aio/runtime/quasar-init.lisp
export XDG_DATA_HOME=/opt/quasar-aio/state/quasar
export XDG_CACHE_HOME=/opt/quasar-aio/state/cache

cd /opt/quasar-aio/app/quasar
exec /opt/quasar-aio/runtime/bin/quasar-server
