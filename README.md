# Quasar

Quasar is the canonical Common Lisp control plane and runtime for the Quasar investigation workspace, with the React/Cytoscape UI tracked directly under `frontend/` in this monorepo. The UI is a presentation and standalone-web layer; it is not the complete Quasar or StarIntel capability set.

The full deployment is layered:

```text
Quasar UI (`frontend/`, sourced from quasar-ui)
  browser UI / graph renderer / standalone subset
        |
        | versioned commands, projections, capability discovery
        v
quasar
  canonical Common Lisp control plane and runtime
        |
        | embedded durable document/graph persistence
        v
Tek9 -> LMDB
        |
        | StarIntel APIs and service adapters
        v
starintel-server
  persistent ingest / search / routing / RabbitMQ services
        |
        +-----------------------------+
        |                             |
        v                             v
star-bbpd                       other actor services
  external recon actors          collectors / analyzers / tools
```

`star-bbpd`, for example, is an external Python/Pykka actor service that consumes RabbitMQ targets, runs reconnaissance tools such as Subfinder, Nmap, Httpx, Katana and DNS workflows, and publishes derived StarIntel documents and relations. Those capabilities are not reimplemented inside the browser UI.

See [Architecture](docs/ARCHITECTURE.md), the [Tek9 storage ADR](docs/ADR-TEK9-WORKSPACE-STORAGE.md), the [record-bounded mutation ADR](docs/ADR-RECORD-BOUNDED-MUTATIONS.md), the [UI migration ledger](docs/UI-MIGRATION.md), and the [capability boundary](docs/CAPABILITY-BOUNDARY.md) for the detailed ownership split.

## Architecture

- React, Cytoscape, routing, responsive presentation, editing buffers, hover,
  menus, and animation remain in the browser.
- Common Lisp owns canonical documents, named graph definitions, committed
  graph presentation state, revisions, transactions, and the operation journal.
- Tek9 is the canonical local embedded document/graph store and LMDB is the
  durable engine beneath it. Ordinary Tek9 mutations use a record-level overlay
  rather than a fully materialized canonical workspace candidate.
- Direct document reads, paged snapshots, durable import staging/promotion, and
  ordinary Tek9 mutations are bounded-memory paths. Mutation memory is
  proportional to the explicitly touched records plus validation dependencies,
  not the unrelated workspace corpus.
- The legacy full-workspace cache remains a compatibility structure, not durable
  authority, and ordinary Tek9 mutations do not populate it.
- Cytoscape is a presentation projection. PouchDB is populated only when an
  explicit CouchDB synchronization needs browser-local staging. Migrated
  document and graph writes never fall back to PouchDB.
- WebSocket callbacks authenticate and validate requests, then enqueue commands
  on the Sento control-plane actor. They never mutate workspace state directly.
- CLOG serves the production bundle and issues the browser session token.
- StarLang remains a Common Lisp subsystem and `starlang.load` is excluded from
  the normal browser capability set.
- Runtime and external-service controls discover capabilities rather than
  assuming `starintel-server`, BBPD, or other actor services are always present.

## Development

Node.js 22.12 or newer, SBCL, Quicklisp, LMDB, SQLite, OpenSSL, libffi, and
RabbitMQ C libraries are required. The supported Nix shell supplies the native
libraries and runtime tools:

```sh
nix develop
bash scripts/bootstrap-lisp-deps
npm ci
npm run dev
```

`scripts/bootstrap-lisp-deps` is the canonical source for git-pinned Common Lisp
source dependencies such as CLOG and Tek9. It installs exact commits into
Quicklisp `local-projects` and refuses to overwrite a dirty existing checkout.
CI calls the same script rather than carrying a second set of dependency pins.

On Linux hosts with Nix available, plain `npm run dev` and
`./scripts/run-production` automatically re-enter this repository's pinned Nix
shell so CLOG, Tek9, and the other CFFI systems can resolve their native
libraries. Other platforms use the libraries installed on the host.

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

The default durable local workspace path follows XDG:
`$XDG_DATA_HOME/quasar/tek9/`, or `~/.local/share/quasar/tek9/` when
`XDG_DATA_HOME` is unset. Tests and deployments can override the path or inject
an existing store.

## Validation

Run commands from the repository root:

```sh
npm run check              # format, lint, types, boundaries, mutation architecture guard
npm run test               # Common Lisp + all frontend unit/integration tests
npm run smoke              # real Vite/CLOG/WebSocket command exchange
npm run test:e2e           # Playwright against the complete real stack
npm run smoke:production   # fresh install, package, serve, route/PWA/security smoke
```

The Common Lisp suite includes restart/failure tests, Phase 2 bounded-read and
durable-import tests, Phase 3 record-bounded mutation tests, 1k-vs-10k retained
working-set comparisons, and a real 10,000-document Tek9 corpus. The structural
mutation guard rejects production paths that regress to full-workspace loading,
private Tek9 APIs, or raw LMDB access.

Playwright uses an isolated authorized workspace per test and covers desktop,
mobile, real UI mutation, graph membership, reload, and authoritative snapshot
restore. The production smoke verifies hashed assets, nested SPA routes,
manifest/service worker paths, session and Origin rejection, workspace
isolation, capability denial, malformed requests, and message-size limits.

## Production

Build and start the packaged server from a fresh dependency state:

```sh
nix develop
bash scripts/bootstrap-lisp-deps
./scripts/run-production
```

The script runs the root `npm ci`, builds `frontend/dist`, creates the
`quasar-server` executable, and starts it at `http://127.0.0.1:8080`. Use
`./scripts/run-production --build-only` when packaging without starting it.
Production serves the application at `/`; Vite, React Router, CLOG, the PWA
manifest, and service-worker scope use that same base path.

## Protocol and durable graph contract

Commands and responses use `quasar.control.v1` envelopes with correlated IDs,
stable error codes, and workspace metadata. Production Tek9 mutations read
workspace metadata plus only records required by the operation, apply and
validate against a bounded record-level overlay, and compile the existing typed
persistence changes. One Tek9/LMDB transaction then commits the affected
canonical records/topology, workspace metadata and revision, and one journal
entry. Success events are emitted only after that durable transaction commits.

Transactions use the same overlay in deterministic operation order and provide
read-your-own-writes. Memory may grow with the transaction's explicit touched
records and validation dependencies, but not with unrelated workspace size. The
bounded transaction budget is 1000 child operations.

StarIntel documents and relation documents are the intelligence records. A
named graph stores membership plus committed positions, viewport, layout, and
groups. Optional graph node/edge records are view records whose document and
endpoint references are validated; they are not a second intelligence corpus.
The `all-documents` graph projects the full corpus with `documentIds: null`.
Selection, pan/zoom frames, and editing state remain browser-local. Relation
documents cannot be deleted while a live graph edge still references them.

Implemented durable commands include:

- `workspace.snapshot`, `workspace.transaction`
- `document.list`, `document.get`, `document.create`, `document.update`,
  `document.delete`
- `document.import.begin/chunk/commit/abort`
- `graph.snapshot`, `graph.workspace.put`, `graph.workspace.delete`,
  `graph.workspace.activate`
- `graph.node.*`, `graph.edge.*`
- capability-gated `starlang.status` and `starlang.load`

Transaction child events have unique operation IDs, a shared transaction ID,
one committed revision, stable order, event index, and event count.
File imports are fully prevalidated in the browser, then large corpora are sent
as ordered, size-bounded chunks below the WebSocket security limit. Import
sessions are durably staged in Tek9 with ordered chunk identity, budgets,
restart-safe promotion/abort, and bounded cleanup. Promotion remains one atomic
durable commit before success is emitted.

## Transitional boundaries

Actor/research execution and optional browser network integrations have not all
moved behind Common Lisp or their owning StarIntel service commands yet. PouchDB
remains a CouchDB ingress/egress staging layer used only during explicit
synchronization; pulled documents are validated and committed through the
control plane before becoming authoritative. Browser settings still support
existing local integrations, and settings transfer filters credential fields.
These adapters must not be used as fallback authority for document or graph
mutations.

Missing backend or external capabilities reduce the advertised capability set;
they do not silently become browser implementations with weaker semantics.
