#!/bin/bash
set -euo pipefail

# shellcheck disable=SC1091
source /opt/quasar-aio/state/secrets/runtime.env
mkdir -p /opt/quasar-aio/state/valkey

exec valkey-server \
  --bind 127.0.0.1 \
  --protected-mode yes \
  --port 6379 \
  --dir /opt/quasar-aio/state/valkey \
  --appendonly yes \
  --requirepass "$VALKEY_PASSWORD" \
  --daemonize no
