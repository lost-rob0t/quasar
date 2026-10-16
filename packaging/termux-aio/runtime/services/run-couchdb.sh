#!/bin/bash
set -euo pipefail

mkdir -p /opt/quasar-aio/state/couchdb/data /opt/quasar-aio/state/couchdb/views
chown -R couchdb:couchdb /opt/quasar-aio/state/couchdb || true

couchdb_bin="$(command -v couchdb 2>/dev/null || true)"
if [[ -z "$couchdb_bin" ]]; then
  couchdb_bin=/opt/couchdb/bin/couchdb
fi

test -x "$couchdb_bin"
exec runuser -u couchdb --preserve-environment -- "$couchdb_bin"
