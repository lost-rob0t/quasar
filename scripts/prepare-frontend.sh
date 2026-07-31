#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
frontend_root="$repo_root/frontend"
control_plane_overlay="$repo_root/frontend-overlay/src/lib/control-plane.js"
control_plane_target="$frontend_root/src/lib/control-plane.js"
auto_dig_overlay="$repo_root/frontend-overlay/src/integrations/auto-dig/AutoDigHostBridge.jsx"
auto_dig_target="$frontend_root/src/integrations/auto-dig/AutoDigHostBridge.jsx"
entrypoint="$frontend_root/src/app/main.tsx"

if [[ ! -f "$frontend_root/package.json" ]]; then
  git -C "$repo_root" submodule update --init --recursive frontend
fi

install -D -m 0644 "$control_plane_overlay" "$control_plane_target"
install -D -m 0644 "$auto_dig_overlay" "$auto_dig_target"

python3 - "$entrypoint" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()

control_plane_import = 'import "../lib/control-plane.js";\n'
control_plane_marker = 'import { StrictMode } from "react";\n'
if control_plane_import not in source:
    if control_plane_marker not in source:
        raise SystemExit(f"frontend bootstrap marker not found in {path}")
    source = source.replace(
        control_plane_marker,
        control_plane_marker + control_plane_import,
        1,
    )

auto_dig_import = (
    'import AutoDigHostBridge, { isAutoDigEmbedded } from '
    '"../integrations/auto-dig/AutoDigHostBridge.jsx";\n'
)
auto_dig_import_marker = 'import App from "../App.jsx";\n'
if auto_dig_import not in source:
    if auto_dig_import_marker not in source:
        raise SystemExit(f"AutoDig import marker not found in {path}")
    source = source.replace(
        auto_dig_import_marker,
        auto_dig_import_marker + auto_dig_import,
        1,
    )

auto_dig_component = "        <AutoDigHostBridge />\n"
auto_dig_component_marker = "        <App />\n"
if auto_dig_component not in source:
    if auto_dig_component_marker not in source:
        raise SystemExit(f"AutoDig component marker not found in {path}")
    source = source.replace(
        auto_dig_component_marker,
        auto_dig_component_marker + auto_dig_component,
        1,
    )

service_worker_old = (
    'if ("serviceWorker" in navigator && import.meta.env.PROD) {\n'
)
service_worker_new = (
    'if ("serviceWorker" in navigator && import.meta.env.PROD && '
    '!isAutoDigEmbedded()) {\n'
)
if service_worker_new not in source:
    if service_worker_old not in source:
        raise SystemExit(f"service worker marker not found in {path}")
    source = source.replace(service_worker_old, service_worker_new, 1)

path.write_text(source)
PY

printf 'Prepared Quasar frontend overlays at %s\n' "$frontend_root"
