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
```

See [Architecture](docs/ARCHITECTURE.md), the [Tek9 storage ADR](docs/ADR-TEK9-WORKSPACE-STORAGE.md), and the [record-bounded mutation ADR](docs/ADR-RECORD-BOUNDED-MUTATIONS.md) for the storage/runtime contract.

## Architecture

- React and Cytoscape own browser presentation, editing buffers, hover, menus,
  selection, animation, and other non-canonical UI state.
- Common Lisp owns canonical command validation, documents, named graphs,
  committed graph presentation state, revisions, transactions, journal/event
  ordering, and capability checks.
- Tek9 is canonical local document/graph authority. LMDB is accessed only through
  exported Tek9 APIs.
- Direct reads, paged snapshots, durable import staging/promotion, and ordinary
  Tek9 mutations are bounded-memory paths. Ordinary mutations retain a
  record-level overlay proportional to touched records and validation
  dependencies rather than the unrelated workspace corpus.
- The legacy full-workspace cache is a compatibility structure, not durable
  authority, and ordinary Tek9 mutations do not populate it.
- Explicit whole-graph replacement may materialize the one graph explicitly
  replaced; it does not hydrate unrelated graphs or the document corpus.
- WebSocket callbacks authenticate and validate requests, then enqueue commands
  on the Sento control-plane actor. They never mutate canonical state directly.
- Cytoscape and PouchDB are projections/staging adapters, never fallback mutation
  authorities.

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

`scripts/bootstrap-lisp-deps` installs the exact git-pinned Lisp dependencies,
including Tek9, into Quicklisp `local-projects` and refuses to overwrite dirty
checkouts. CI uses the same bootstrap path.

The default durable local workspace path is `$XDG_DATA_HOME/quasar/tek9/`, or
`~/.local/share/quasar/tek9/` when `XDG_DATA_HOME` is unset.

## Validation

Run commands from the repository root:

```sh
npm run check              # frontend checks + boundaries + mutation architecture guard
npm run test               # Common Lisp + frontend unit/integration tests
npm run smoke              # real Vite/CLOG/WebSocket command exchange
npm run test:e2e           # Playwright against the complete real stack
npm run smoke:production   # package, serve, route/PWA/security smoke
```

The Lisp suite includes durable restart/failure tests, Phase 2 read/import tests,
Phase 3 record-bounded mutation tests, 1k-vs-10k retained-working-set checks, and
a real 10,000-document Tek9 corpus. The CI workflow additionally loads the real
`quasar-web` system and runs development-stack, browser, packaged production,
routing, PWA, and security smokes.

## Protocol and durable mutation contract

Commands and responses use `quasar.control.v1` envelopes with correlated IDs,
stable error codes, and workspace metadata. For a production Tek9 mutation the
control plane reads durable metadata plus only records needed by the operation,
applies validation to a small mutation overlay, compiles the existing typed
persistence changes, and commits canonical records, graph topology, workspace
metadata/revision, and one journal entry in one Tek9 write transaction.

Only after the durable transaction commits may Quasar broadcast success events.
A failed persistence attempt leaves canonical records, graph state, revision,
journal, and events unchanged.

Transactions use the same overlay, execute child operations in deterministic
order, and provide read-your-own-writes. Memory may grow with the explicit
transaction mutation/dependency set, but not with unrelated workspace size. A
transaction is limited to 1000 child operations.

Implemented durable commands include:

- `workspace.snapshot`, `workspace.transaction`
- `document.list`, `document.get`, `document.create`, `document.update`,
  `document.delete`
- `document.import.begin/chunk/commit/abort`
- `graph.snapshot`, `graph.workspace.put`, `graph.workspace.delete`,
  `graph.workspace.activate`
- `graph.node.*`, `graph.edge.*`
- capability-gated `starlang.status` and `starlang.load`

StarIntel documents and relation documents remain the intelligence records. A
named graph stores membership plus committed positions, viewport, layout, and
groups. Optional node/edge records are view records whose document and endpoint
references are validated; they are not a second intelligence corpus.

## Production

Build and start the packaged server from a fresh dependency state:

```sh
nix develop
bash scripts/bootstrap-lisp-deps
./scripts/run-production
```

The production script installs dependencies, builds `frontend/dist`, creates the
`quasar-server` executable, and serves the app at `http://127.0.0.1:8080`.
Production WebSockets require the CLOG-issued session and allowed Origin; local
insecure mode is restricted to development/test workflows.
