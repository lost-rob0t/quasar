#!/bin/bash
set -euo pipefail

AIO=/opt/quasar-aio
STATE="$AIO/state"
RUNTIME="$AIO/runtime"
SECRETS="$STATE/secrets"

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

mkdir -p "$STATE" "$SECRETS" "$STATE/logs" "$RUNTIME/bin"

# PRoot has no systemd. Prevent package maintainer scripts from attempting to
# start daemons during apt transactions; supervisord owns them instead.
cat >/usr/sbin/policy-rc.d <<'EOF'
#!/bin/sh
exit 101
EOF
chmod 0755 /usr/sbin/policy-rc.d

apt-get update
apt-get install -y --no-install-recommends \
  apt-transport-https \
  build-essential \
  ca-certificates \
  curl \
  git \
  gnupg \
  jq \
  libffi-dev \
  libffi8 \
  liblmdb-dev \
  liblmdb0 \
  librabbitmq-dev \
  librabbitmq4 \
  libsqlite3-0 \
  libsqlite3-dev \
  libssl-dev \
  openssl \
  procps \
  rabbitmq-server \
  sbcl \
  supervisor \
  util-linux \
  valkey-server

if [[ ! -f /usr/share/keyrings/couchdb-archive-keyring.gpg ]]; then
  curl -fsSL https://couchdb.apache.org/repo/keys.asc \
    | gpg --dearmor -o /usr/share/keyrings/couchdb-archive-keyring.gpg
fi

. /etc/os-release
cat >/etc/apt/sources.list.d/couchdb.list <<EOF
deb [signed-by=/usr/share/keyrings/couchdb-archive-keyring.gpg] https://apache.jfrog.io/artifactory/couchdb-deb/ ${VERSION_CODENAME} main
EOF

if [[ ! -f "$SECRETS/runtime.env" ]]; then
  umask 077
  cat >"$SECRETS/runtime.env" <<EOF
COUCHDB_PASSWORD=$(openssl rand -hex 32)
VALKEY_PASSWORD=$(openssl rand -hex 32)
STAR_AUTH_PEPPER=$(openssl rand -hex 32)
STAR_AUTH_INITIAL_PASSWORD=$(openssl rand -hex 24)
EOF
fi

# shellcheck disable=SC1091
source "$SECRETS/runtime.env"
printf '%s\n' "$VALKEY_PASSWORD" >"$SECRETS/valkey-password"
chmod 0600 "$SECRETS/runtime.env" "$SECRETS/valkey-password"

if ! dpkg-query -W -f='${Status}' couchdb 2>/dev/null | grep -q 'install ok installed'; then
  printf 'couchdb couchdb/mode select standalone\n' | debconf-set-selections
  printf 'couchdb couchdb/bindaddress string 127.0.0.1\n' | debconf-set-selections
  printf 'couchdb couchdb/adminpass password %s\n' "$COUCHDB_PASSWORD" | debconf-set-selections
  printf 'couchdb couchdb/adminpass_again password %s\n' "$COUCHDB_PASSWORD" | debconf-set-selections
  apt-get update
  apt-get install -y couchdb
else
  apt-get update
  apt-get install -y --only-upgrade couchdb || true
fi

mkdir -p \
  "$STATE/couchdb/data" \
  "$STATE/couchdb/views" \
  "$STATE/rabbitmq/mnesia" \
  "$STATE/rabbitmq/log" \
  "$STATE/valkey" \
  "$STATE/quasar/tek9"

chown -R couchdb:couchdb "$STATE/couchdb" || true
chown -R rabbitmq:rabbitmq "$STATE/rabbitmq" || true

mkdir -p /opt/couchdb/etc/local.d
cat >/opt/couchdb/etc/local.d/quasar-aio.ini <<EOF
[couchdb]
single_node = true
database_dir = $STATE/couchdb/data
view_index_dir = $STATE/couchdb/views

[chttpd]
bind_address = 127.0.0.1
port = 5984

[admins]
admin = $COUCHDB_PASSWORD
EOF
chown couchdb:couchdb /opt/couchdb/etc/local.d/quasar-aio.ini || true
chmod 0600 /opt/couchdb/etc/local.d/quasar-aio.ini

mkdir -p /etc/rabbitmq
cat >/etc/rabbitmq/rabbitmq.conf <<'EOF'
listeners.tcp.1 = 127.0.0.1:5672
loopback_users.guest = true
log.console = true
log.console.level = info
EOF

chmod 0755 "$RUNTIME"/*.sh "$RUNTIME/services"/*.sh

"$RUNTIME/build-images.sh"

touch "$STATE/.bootstrapped"
printf 'Quasar AIO Debian bootstrap complete.\n'
