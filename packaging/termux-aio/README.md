# Quasar all-in-one for Termux

This bundle turns one Termux install into a self-contained local Quasar appliance.
It is intentionally **not** the lightweight browser-only build and it is not just
an ingest uploader.

## What runs locally

Inside one rootless Debian userland managed by `proot-distro`:

- Quasar Common Lisp control plane + CLOG production UI (`127.0.0.1:8080`)
- Quasar control WebSocket (`127.0.0.1:8081`)
- Tek9/LMDB local Quasar workspace storage
- StarIntel gserver (`127.0.0.1:5000`)
- CouchDB (`127.0.0.1:5984`)
- RabbitMQ (`127.0.0.1:5672`)
- Valkey (`127.0.0.1:6379`)

`supervisord` owns the daemons. No systemd, root, Docker daemon, or remote
StarIntel server is required after installation.

The Quasar frontend is built by CI with its default StarIntel server set to the
local gserver. The Common Lisp source dependency closure is also captured by CI,
so the phone does not run npm or clone application repositories during runtime
bootstrap.

## Install

Extract the release ZIP in Termux and run:

```sh
bash install-termux.sh
```

The installer:

1. installs `proot-distro` in Termux;
2. installs a rootless Debian Trixie userland;
3. copies this versioned payload under `~/.local/share/quasar-aio`;
4. installs the `quasar-aio` command into `$PREFIX/bin`;
5. installs Debian runtime packages and Apache CouchDB;
6. generates local-only credentials;
7. builds the two SBCL saved executables from the vendored Lisp closure;
8. starts the appliance and runs its health checks.

The Debian/apt package installation needs network access on first bootstrap.
Quasar's JavaScript and Lisp application sources are already in the bundle.

## Control

```sh
quasar-aio start
quasar-aio stop
quasar-aio restart
quasar-aio status
quasar-aio doctor
quasar-aio logs
quasar-aio logs star-server
quasar-aio shell
quasar-aio url
```

Open `http://127.0.0.1:8080` in the Android browser after `doctor` is green.

## Security boundary

The appliance is a single-user local sandbox. Every network service is bound to
loopback. StarIntel authentication uses the local development bypass so Quasar
can talk to its co-located gserver without persisting an API key in browser
storage. **Do not change the service binds to `0.0.0.0` while that bypass is
enabled.** Use normal StarIntel authentication for any LAN, VPN, tunnel, or
public deployment.

Random CouchDB, Valkey, StarIntel pepper, and initial-user secrets are generated
on first bootstrap under `~/.local/share/quasar-aio/state/secrets/`.

## State

Persistent application state lives under:

```text
~/.local/share/quasar-aio/state/
  couchdb/
  rabbitmq/
  valkey/
  quasar/
  logs/
  secrets/
```

The Debian userland itself is stored by `proot-distro`. The application data is
kept in the bind-mounted directory above so replacing/resetting the userland does
not intentionally become the data storage model.
