# Inspecting WebSocket disconnects

Run the reusable inspector from the checkout being investigated:

```sh
nix develop -c node scripts/inspect-websocket.mjs --seconds 60
```

This starts the complete Lisp control plane, CLOG HTTP host, and Vite UI on
8181, 8180, and 5183. It uses a separate data/config directory and stops its
processes at the end. Dependencies must be installed (`npm ci`) and Playwright
Chromium must be available (`npx playwright install chromium`). On hosts with
the native runtime libraries already configured, `node` can be used directly.

To inspect an existing stack, including its populated workspace:

```sh
node scripts/inspect-websocket.mjs --url http://127.0.0.1:5173 --seconds 120
```

Use `--headed` to interact with the inspected browser during capture. Use
`--output /tmp/quasar-websocket-capture` for a stable artifact location.
`--drop-once` deliberately closes one control-plane connection and checks that
a second connection synchronizes successfully:

```sh
nix develop -c node scripts/inspect-websocket.mjs --drop-once --seconds 15
```

## Evidence

The inspector writes `events.jsonl`, `summary.json`, and `ui.png`. Frame records
contain request IDs, status, revision, page progress, and byte counts; document
payloads are omitted. Query-string credentials are redacted. Server debug output
is captured when the inspector launches the stack. Existing-stack mode records
browser evidence; server output stays with that stack's supervisor.

The summary counts control-protocol connections, closes, frames, protocol errors,
UI error events, and final synchronization state. Vite HMR sockets are identified
separately. Deliberate browser shutdown occurs after the summary and does not
count as an observed disconnect. Startup failure or failure to synchronize exits
nonzero.

Open the UI with `?debug=1` to enable transport tracing (also available in
production builds). `?debug=0` disables it. Look for:

- `close`: browser close code, reason, clean flag, and pending request count.
- `client-close`: synchronization failed and the client initiated the close.
- `synchronize-failed`: protocol/application error code preceding that close.
- `state`: connection phase and synchronization state.

An open socket does not mean the workspace has synchronized. In a local capture
at commit `9079604f766990db7f9b8998705862c4fa914c45`, the populated workspace
required 109 snapshot pages for 45,348 documents at revision 659. A 65-second
capture completed synchronization with one connection, zero closes, and zero UI
errors. This idle capture did not reproduce the reported intermittent spam.

## Confirmed lifecycle defects

- The red disconnected banner remained visible after a successful reconnect.
  It now clears when the current connection has synchronized; unrelated notices
  are preserved. The inspector fails if that stale banner remains visible.
- One socket close previously produced both disconnected and reconnecting
  diagnostic warnings. Only the disconnected transition now records the warning.
- A rejected obsolete synchronization could close the currently active socket.
  Synchronization failure cleanup now checks attempt/socket ownership and disposal.
- The Lisp launcher's ASDF registry previously searched Quicklisp local projects
  before this checkout. A full-stack worktree capture loaded another Quasar
  implementation (missing `quasar.plugin`). The active checkout and vendored
  bindings now take precedence.

These defects are independently reproducible. The user's intermittent disconnect
trigger remains unconfirmed until a capture records it during the relevant UI action.

## Connection status in the UI

An open socket transferring snapshot pages shows **Loading workspace**, with a
document count and progress bar. This is distinct from **Reconnecting**, which
means the transport is being retried. The disconnected notification is informational
and clears as soon as the transport opens for synchronization. Workspace content
is shown after synchronization, so an unfinished snapshot is not presented as an
empty corpus. Stopped optional integrations no longer force a red Degraded summary;
actual integration errors and control-plane failures remain visible.

The inspector also writes `startup.png` to show the initial connection/loading UI.
