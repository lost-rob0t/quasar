#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
frontend_root="$repo_root/frontend"
overlay="$repo_root/frontend-overlay/src/lib/control-plane.js"
target="$frontend_root/src/lib/control-plane.js"
entrypoint="$frontend_root/src/app/main.tsx"

if [[ ! -f "$frontend_root/package.json" ]]; then
  git -C "$repo_root" submodule update --init --recursive frontend
fi

install -D -m 0644 "$overlay" "$target"

python3 - "$entrypoint" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
line = 'import "../lib/control-plane.js";\n'

if line not in source:
    marker = 'import { StrictMode } from "react";\n'
    if marker not in source:
        raise SystemExit(f"frontend bootstrap marker not found in {path}")
    source = source.replace(marker, marker + line, 1)
    path.write_text(source)
PY

printf 'Prepared Quasar UI control-plane bridge at %s\n' "$frontend_root"
