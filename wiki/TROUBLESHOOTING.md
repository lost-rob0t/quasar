# Troubleshooting

Start with:

```sh
quasar doctor
quasar status
```

## Docker daemon unavailable

If `quasar doctor` reports that the Docker CLI exists but the daemon is unavailable, start Docker Engine or Docker Desktop and retry. Under WSL2, confirm Docker Desktop WSL integration is enabled for the distro you are using.

## Compose unavailable

The bundle requires Docker Compose v2 through:

```sh
docker compose version
```

The legacy `docker-compose` v1 executable is not the supported interface.

## Nix cannot build or load StarIntel images

The bundle uses a pinned StarIntel Server revision, not a moving branch. Confirm network access to GitHub and run:

```sh
quasar doctor
quasar install
```

Do not manually substitute arbitrary StarIntel image versions; the bundle versions are a compatibility contract.

## StarIntel is unhealthy

```sh
quasar logs starintel
curl --fail http://127.0.0.1:5000/health
```

The normal dependency order is Clouseau -> CouchDB, plus RabbitMQ and Valkey, then StarIntel Server. A backend health failure prevents the server from being considered ready.

## Quasar is not reachable

```sh
quasar logs quasar
curl --fail http://127.0.0.1:8080/
```

Quasar starts after the local StarIntel backend under user systemd. Without user systemd, the CLI uses its process fallback and records the process ID in the XDG state directory.

## User systemd is unavailable

This is supported. `quasar up` falls back to direct Compose management and a supervised PID/log path for Quasar.

Under WSL, systemd can be enabled independently; the bundle does not require it.

## Secret Service is unavailable

The installer can fall back to mode-`0600` credential files. Under WSL with Windows interop it prefers DPAPI instead.

Run:

```sh
quasar doctor
```

to see the selected backend.

## Reset everything

Only use this when you intentionally want to destroy the local installation:

```sh
quasar purge --yes
quasar install
quasar up
```

This deletes local Quasar state/config credentials and the StarIntel Docker volumes. Back up required data first.
