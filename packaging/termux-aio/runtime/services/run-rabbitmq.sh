#!/bin/bash
set -euo pipefail

mkdir -p /opt/quasar-aio/state/rabbitmq/mnesia /opt/quasar-aio/state/rabbitmq/log
chown -R rabbitmq:rabbitmq /opt/quasar-aio/state/rabbitmq || true

export HOME=/var/lib/rabbitmq
export RABBITMQ_MNESIA_BASE=/opt/quasar-aio/state/rabbitmq/mnesia
export RABBITMQ_LOG_BASE=/opt/quasar-aio/state/rabbitmq/log
export RABBITMQ_PID_FILE=/opt/quasar-aio/state/rabbitmq/rabbitmq.pid

exec runuser -u rabbitmq --preserve-environment -- rabbitmq-server
