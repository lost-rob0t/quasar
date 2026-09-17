# Operations

## Normal lifecycle

```sh
quasar up
quasar status
quasar down
```

`down` stops the application while preserving Quasar data, StarIntel Docker volumes, and credentials.

## Logs

```sh
quasar logs starintel
quasar logs quasar
```

The StarIntel view follows the container backend. Quasar uses the user journal when systemd is available and an XDG state log in fallback mode.

## Host checks

```sh
quasar doctor
```

The doctor checks Nix, Docker, Compose, OpenSSL, curl, the Docker daemon, the selected secret backend, the pinned StarIntel source revision, and bundle assets.

## Credentials

Infrastructure credentials are generated at initialization. They are not written into the repository, Nix derivation, Compose model, or shell profile.

The first StarIntel administrator password can be retrieved with:

```sh
quasar admin-password
```

Do not paste generated credentials into tracked config files.

## Data locations

Quasar follows XDG locations:

- configuration: `$XDG_CONFIG_HOME/quasar` or `~/.config/quasar`
- data: `$XDG_DATA_HOME/quasar` or `~/.local/share/quasar`
- state/logs/runtime materialization: `$XDG_STATE_HOME/quasar` or `~/.local/state/quasar`

StarIntel persistence lives in named Docker volumes for CouchDB, Clouseau, RabbitMQ, and Valkey.

## Backup

Back up Quasar's XDG data directory while Quasar is stopped.

For StarIntel intelligence documents, use CouchDB's HTTP export/replication facilities rather than copying a live database volume. Clouseau indexes are derived and can be rebuilt from CouchDB.

A minimal local maintenance sequence is:

```sh
quasar down
# back up Quasar XDG data here
quasar up
```

Use StarIntel's dedicated backup documentation for CouchDB database exports before upgrades or destructive maintenance.

## Upgrade

The end-user package pins a tested StarIntel Server revision. Upgrade the Quasar Nix profile as one unit rather than independently replacing backend image tags:

```sh
nix profile upgrade quasar-end-user
quasar down
quasar up
quasar status
```

A release should not move the StarIntel revision without passing the bundle smoke contract.

## Uninstall vs purge

Preserve all data and credentials but remove installed user services:

```sh
quasar uninstall
```

Destroy local Quasar data, credentials, and StarIntel Docker volumes:

```sh
quasar purge --yes
```

`purge` is intentionally explicit and destructive.
