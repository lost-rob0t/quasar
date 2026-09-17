#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

fail() {
  printf 'quasar-aio installer: %s\n' "$*" >&2
  exit 1
}

command -v pkg >/dev/null 2>&1 || fail "run this installer inside Termux"
: "${PREFIX:?Termux PREFIX is not set}"

bundle_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
payload_dir="$bundle_dir/payload"
aio_home="${QUASAR_AIO_HOME:-$HOME/.local/share/quasar-aio}"
distro="${QUASAR_AIO_DISTRO:-quasar-aio-debian}"

test -d "$payload_dir" || fail "payload/ is missing; extract the complete release ZIP first"

printf '[1/5] Installing Termux host prerequisites...\n'
pkg install -y proot-distro curl ca-certificates

printf '[2/5] Ensuring rootless Debian Trixie userland...\n'
if ! proot-distro login "$distro" -- /bin/true >/dev/null 2>&1; then
  proot-distro install debian:trixie --name "$distro"
fi

printf '[3/5] Installing versioned Quasar payload...\n'
mkdir -p "$aio_home"
cp -a "$payload_dir/." "$aio_home/"
chmod 0755 \
  "$aio_home/runtime/bootstrap-debian.sh" \
  "$aio_home/runtime/build-images.sh" \
  "$aio_home/runtime/doctor.sh" \
  "$aio_home/runtime/services/"*.sh

install -m755 "$bundle_dir/quasar-aio" "$PREFIX/bin/quasar-aio"

# Rebuild saved Lisp images when a new bundle is installed. Persistent data is
# untouched; only generated executables are invalidated.
rm -f "$aio_home/runtime/bin/quasar-server" "$aio_home/runtime/bin/star-server"

printf '[4/5] Bootstrapping local Quasar/StarIntel services...\n'
QUASAR_AIO_HOME="$aio_home" QUASAR_AIO_DISTRO="$distro" quasar-aio bootstrap

printf '[5/5] Starting appliance...\n'
QUASAR_AIO_HOME="$aio_home" QUASAR_AIO_DISTRO="$distro" quasar-aio start

printf '\nQuasar all-in-one is installed.\n'
printf 'Open: http://127.0.0.1:8080\n'
printf 'Check: quasar-aio doctor\n'
printf 'Logs:  quasar-aio logs\n'
