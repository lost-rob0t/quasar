# Quasar

Quasar is a React/Cytoscape investigation UI backed by a Common Lisp
single-writer control plane. The UI is tracked directly in this monorepo; there
is no frontend submodule or generated overlay.

## Architecture

- React, Cytoscape, routing, responsive presentation, editing buffers, hover,
  menus, and animation remain in the browser.
- Common Lisp owns canonical documents, named graph definitions, committed
  graph presentation state, revisions, transactions, and the operation journal.
- Cytoscape and the local PouchDB corpus are projections. Migrated document and
  graph writes never fall back to PouchDB.
- WebSocket callbacks authenticate and validate requests, then enqueue commands
  on the Sento control-plane actor. They never mutate workspace state directly.
- CLOG serves the production bundle and issues the browser session token.
- StarLang remains a Common Lisp subsystem and `starlang.load` is excluded from
  the normal browser capability set.

See [Architecture](docs/ARCHITECTURE.md) and the
[UI migration ledger](docs/UI-MIGRATION.md) for the detailed boundaries.

## Development

Node.js 22.12 or newer, SBCL, Quicklisp, SQLite, OpenSSL, libffi, and
RabbitMQ C libraries are required. The supported Nix shell supplies these:

```sh
nix develop
npm ci
npm run dev
```

On Linux hosts with Nix available, plain `npm run dev` and
`./scripts/run-production` automatically re-enter this repository's pinned Nix
shell so CLOG can resolve SQLite and the other native libraries. Other platforms
use the libraries installed on the host.

One root `npm ci` installs the complete npm workspace. `npm run dev` supervises
the Common Lisp control plane, WebSocket endpoint, CLOG host, and Vite without
using `npx` or downloading undeclared packages. The local endpoints are:

- React/Vite: `http://127.0.0.1:5173`
- CLOG production host: `http://127.0.0.1:8080`
- control-plane WebSocket: `ws://127.0.0.1:8081`

Development builds log uncaught browser errors, rejected promises, and React
component stacks. Open `http://127.0.0.1:5173/?debug=1` to additionally trace
WebSocket lifecycle, command IDs, revisions, and pending-request counts without
logging payloads or credentials. Use `?debug=0` to disable that transport trace.

`./scripts/run-control-plane` starts only the Lisp/CLOG/WebSocket side. The
development scripts explicitly enable unauthenticated local mode; production
does not.

## Validation

Run commands from the repository root:

```sh
npm run check              # format, lint, types, boundaries, static syntax
npm run test               # Common Lisp + all frontend unit/integration tests
npm run smoke              # real Vite/CLOG/WebSocket command exchange
npm run test:e2e           # Playwright against the complete real stack
npm run smoke:production   # fresh install, package, serve, route/PWA/security smoke
```

Playwright uses an isolated authorized workspace per test and covers desktop,
mobile, real UI mutation, graph membership, reload, and authoritative snapshot
restore. The production smoke verifies hashed assets, nested SPA routes,
manifest/service worker paths, session and Origin rejection, workspace
isolation, capability denial, malformed requests, and message-size limits.

## Production

Build and start the packaged server from a fresh dependency state:

```sh
nix develop
./scripts/run-production
```

The script runs the root `npm ci`, builds `frontend/dist`, creates the
`quasar-server` executable, and starts it at `http://127.0.0.1:8080`. Use
`./scripts/run-production --build-only` when packaging without starting it.
Production serves the application at `/`; Vite, React Router, CLOG, the PWA
manifest, and service-worker scope use that same base path.

## Protocol and durable graph contract

Commands and responses use `quasar.control.v1` envelopes with correlated IDs,
stable error codes, and workspace metadata. Successful mutations persist the
isolated candidate workspace and journal record atomically before the live
workspace is replaced, acknowledged, or broadcast.

StarIntel documents and relation documents are the intelligence records. A
named graph stores membership plus committed positions, viewport, layout, and
groups. Optional graph node/edge records are view records whose document and
endpoint references are validated; they are not a second intelligence corpus.
The `all-documents` graph projects the full corpus with `documentIds: null`.
Selection, pan/zoom frames, and editing state remain browser-local.

Implemented durable commands include:

- `workspace.snapshot`, `workspace.transaction`
- `document.list`, `document.get`, `document.create`, `document.update`,
  `document.delete`
- `graph.snapshot`, `graph.workspace.put`, `graph.workspace.delete`,
  `graph.workspace.activate`
- `graph.node.*`, `graph.edge.*`
- capability-gated `starlang.status` and `starlang.load`

Transaction child events have unique operation IDs, a shared transaction ID,
one committed revision, stable order, event index, and event count.
File imports are fully prevalidated in the browser, then large corpora are sent
as ordered, size-bounded transactions below the WebSocket security limit. Each
chunk is atomic; a later chunk failure is reported with the already committed
document count instead of claiming whole-corpus rollback.

## Transitional boundaries

Actor/research execution and optional browser network integrations have not all
moved behind Common Lisp commands yet. PouchDB remains a replaceable local query
projection and CouchDB ingress/egress staging layer; pulled documents are
validated and committed through the control plane before becoming
authoritative. Browser settings still support existing local integrations, and
settings transfer filters credential fields. These adapters must not be used as
fallback authority for document or graph mutations.
