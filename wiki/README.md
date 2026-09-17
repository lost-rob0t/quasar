# Quasar operator wiki

This directory is the end-user/operator wiki shipped with the Quasar repository. It covers installation, day-to-day operation, upgrades, backup, and troubleshooting for the local Quasar + StarIntel bundle.

## Start here

- [Install](INSTALL.md) — persistent Nix install, first start, login, and WSL notes.
- [Operations](OPERATIONS.md) — start, stop, status, logs, credentials, backup, and purge.
- [Troubleshooting](TROUBLESHOOTING.md) — Docker, Nix, systemd, WSL, and service-health checks.

## Runtime map

The base end-user stack is intentionally small:

```text
browser
  |
  v
Quasar (Common Lisp, :8080)
  |
  v
StarIntel Server (:5000)
  |---- CouchDB + Clouseau
  |---- RabbitMQ
  `---- Valkey
```

Optional actor fleets are separate installable capabilities. The base bundle does not start collectors, paid actors, or telemetry implicitly.

## Documentation layers

- `docs/` — architecture, protocol, storage, configuration, and implementation reference.
- `wiki/` — operator-facing installation and maintenance.
- `learn/` — guided tutorials and concepts for new users.
