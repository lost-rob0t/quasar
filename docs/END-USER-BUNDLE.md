# Quasar + StarIntel end-user bundle

This is the supported single-machine end-user packaging for Quasar with a local StarIntel backend.

The bundle deliberately keeps the runtime boundary visible while making installation one command. Quasar remains the Common Lisp control plane and UI host; StarIntel Server remains the authenticated ingest/search/routing backend.

## What gets installed

The default stack has exactly six long-running services:

1. `quasar-server` — Common Lisp Quasar control plane, CLOG UI host, and WebSocket endpoint.
2. `star-server` — authenticated StarIntel HTTP/ingest/search/routing service.
3. CouchDB — durable StarIntel documents.
4. Clouseau — CouchDB full-text indexes, internal-only.
5. RabbitMQ — target/document actor transport.
6. Valkey — scheduling, coordination, and ephemeral backend state.

Optional actor fleets and observability are **off by default**. They are not silently installed as part of the base package.

All host-visible service ports bind to loopback by default. Clouseau has no host port. The Docker backend network is marked `internal`.

## Install

Requirements on the host:

- Linux or WSL2
- Nix with flakes enabled
- Docker Engine / Docker Desktop with Compose v2

From a checkout:

```sh
nix run .#end-user -- install
nix run .#end-user -- up
```

From GitHub after this branch is released:

```sh
nix run github:lost-rob0t/quasar#end-user -- install
nix run github:lost-rob0t/quasar#end-user -- up
```

The package pins the StarIntel Server source revision used to build/load the five container images. It never follows `master` implicitly at runtime.

## URLs

| Service | Default endpoint |
|---|---|
| Quasar | `http://127.0.0.1:8080` |
| StarIntel API | `http://127.0.0.1:5000` |
| CouchDB | `http://127.0.0.1:5984` |
| RabbitMQ AMQP | `127.0.0.1:5672` |
| RabbitMQ management | `http://127.0.0.1:15672` |
| Valkey | `127.0.0.1:6379` |

Run `quasar status` for live status and `quasar doctor` for host diagnostics.

## First login

The bundle creates the first StarIntel administrator as `quasar` with a generated password rather than the upstream development `star:intel` bootstrap pair.

Retrieve it only when needed:

```sh
quasar admin-password
```

StarIntel login mints an opaque `star_sk_v1_...` session/API key. Passwords and infrastructure credentials are not embedded in the Compose file, Nix store, shell profile, or repository.

## Credential storage

The CLI selects the strongest locally available storage backend on first initialization and records only the backend name in `~/.config/quasar/stack.conf`.

- Normal Linux desktop: Secret Service through `secret-tool`. This works with GNOME Keyring, KWallet Secret Service support, KeePassXC Secret Service integration, and compatible providers.
- WSL: Windows DPAPI through PowerShell when Windows interop is available.
- Fallback: root-user-only files beneath `$XDG_CONFIG_HOME/quasar/secrets-store/`, mode `0600` under a `0700` directory.

Docker Compose requires file-backed secrets. The CLI materializes temporary copies beneath `$XDG_STATE_HOME/quasar/runtime-secrets/` only while the local stack is operating and removes them on normal shutdown.

## Service management

On Linux with a working user systemd manager, `quasar install` installs and enables:

- `quasar-starintel.service` — starts/stops the five-container backend.
- `quasar.service` — starts Quasar after the backend is healthy.

On WSL or Linux without user systemd, `quasar up`/`down` uses Docker Compose directly and keeps the Quasar process under a PID-file fallback.

The installer does not modify `.bashrc`, `.zshrc`, or another shell profile.

## Operations

```sh
quasar init
quasar install
quasar up
quasar status
quasar logs starintel
quasar logs quasar
quasar down
quasar uninstall
```

`uninstall` removes user services while preserving data and credentials.

The only destructive all-data operation is guarded:

```sh
quasar purge --yes
```

It removes Docker volumes, Quasar local data/state, generated credentials, and installed user units.

## Persistence

StarIntel data survives normal container recreation in named Docker volumes:

- CouchDB documents
- Clouseau indexes
- RabbitMQ state
- Valkey AOF state

Quasar's own authoritative workspace/document/graph data remains in Tek9/LMDB under the normal XDG data path. `down` and `uninstall` do not remove any of these stores.

## Security defaults

- StarIntel authentication is API-key mode.
- Quasar/StarIntel listeners are loopback-only.
- CORS defaults to Quasar's local origins only.
- Telemetry is disabled in the base Compose model.
- Optional actor profiles are absent from the base Compose model.
- No credential is committed or placed in a Nix derivation.
- Clouseau is internal-only.
- The Compose backend network has no external egress.
- Quasar init files are trusted executable Common Lisp and are stored in the user's config directory, not generated into the Nix store.

## Versioning

Quasar owns the end-user bundle contract. A release must pin and test a compatible StarIntel Server revision. Update the pin only with a bundle smoke test covering image load, service health, StarIntel login, Quasar startup, persistence across restart, and destructive purge isolation.
