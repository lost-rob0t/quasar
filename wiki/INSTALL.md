# Install Quasar + StarIntel

The recommended end-user install is the Nix `end-user` package. It installs one `quasar` command containing the Quasar Common Lisp runtime plus the stack manager and pinned StarIntel bundle metadata.

## Requirements

- Linux or WSL2
- Nix with flakes enabled
- Docker Engine or Docker Desktop
- Docker Compose v2

Verify the host first if you already have the package installed:

```sh
quasar doctor
```

## Persistent install

```sh
nix profile install github:lost-rob0t/quasar#end-user
quasar install
quasar up
```

Open:

```text
http://127.0.0.1:8080
```

The StarIntel API is local at:

```text
http://127.0.0.1:5000
```

## One-shot install without changing your Nix profile

Use the same flake app for every operation:

```sh
nix run github:lost-rob0t/quasar#end-user -- install
nix run github:lost-rob0t/quasar#end-user -- up
nix run github:lost-rob0t/quasar#end-user -- status
```

## First StarIntel login

The bundle creates an initial `quasar` administrator with a generated password. Retrieve it only when needed:

```sh
quasar admin-password
```

Use the local StarIntel URL, username `quasar`, and that password when configuring the StarIntel connection in Quasar. StarIntel converts the login into its normal opaque API-key credential.

## Linux credential backend

On a normal desktop session, the installer prefers Secret Service through `secret-tool`. GNOME Keyring, KWallet Secret Service support, KeePassXC Secret Service integration, and compatible providers can satisfy that interface.

If Secret Service is unavailable, the installer uses mode-`0600` files below the user's XDG config directory.

## WSL2

Under WSL, the installer uses Windows DPAPI through PowerShell when Windows interop is available. Docker Desktop integration is supported as long as the `docker` CLI and Compose v2 are visible inside WSL.

User systemd is used when WSL has it enabled. Otherwise `quasar up` and `quasar down` use the built-in process/PID fallback.

## No shell-profile mutation

The installer never edits `.bashrc`, `.zshrc`, `.profile`, or another shell profile. A persistent command comes from `nix profile install`.

## Stop or remove

```sh
quasar down
quasar uninstall
```

`uninstall` preserves documents, Quasar workspaces, Docker volumes, and stored credentials.

To destroy the whole local installation including data and credentials:

```sh
quasar purge --yes
```

There is no unguarded destructive alias.
