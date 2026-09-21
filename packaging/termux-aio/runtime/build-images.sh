#!/bin/bash
set -euo pipefail

AIO=/opt/quasar-aio
BIN="$AIO/runtime/bin"
QUASAR="$AIO/app/quasar"
STAR_SERVER="$AIO/app/starintel-server"

mkdir -p "$BIN" "$AIO/state/cache/common-lisp"

export HOME=/root
export XDG_CACHE_HOME="$AIO/state/cache"
export TMPDIR=/tmp
export TMP=/tmp
export TEMP=/tmp
export CL_SOURCE_REGISTRY="(:source-registry (:tree \"$AIO/app/\") (:tree \"$AIO/vendor/\") (:tree \"$AIO/lisp/software/\") :ignore-inherited-configuration)"

if [[ ! -x "$BIN/quasar-server" ]]; then
  printf 'Building native Quasar SBCL image...\n'
  cd "$QUASAR"
  sbcl --non-interactive --no-userinit --no-sysinit \
    --eval '(require :asdf)' \
    --eval '(asdf:load-system :quasar-web)' \
    --eval "(sb-ext:save-lisp-and-die \"$BIN/quasar-server\" :executable t :toplevel 'quasar.app:main :compression t)"
  chmod 0755 "$BIN/quasar-server"
fi

if [[ ! -x "$BIN/star-server" ]]; then
  printf 'Building native StarIntel gserver SBCL image...\n'
  cd "$STAR_SERVER"
  sbcl --non-interactive --no-userinit --no-sysinit \
    --eval '(require :asdf)' \
    --eval '(asdf:load-system :starintel-gserver)' \
    --eval "(sb-ext:save-lisp-and-die \"$BIN/star-server\" :executable t :toplevel 'star::main :compression t)"
  chmod 0755 "$BIN/star-server"
fi

printf 'Saved images ready:\n  %s\n  %s\n' "$BIN/quasar-server" "$BIN/star-server"
