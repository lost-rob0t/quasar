# Quasar UI binding ledger

The migration changes data/action ownership without replacing the React and
Cytoscape presentation layer or removing visible routes. The browser is a
presentation and interaction layer; a visible control for a runtime or external
service does not make that service a browser implementation.

See [CAPABILITY-BOUNDARY.md](CAPABILITY-BOUNDARY.md) for the complete
`Quasar UI -> quasar -> starintel-server -> external services` split.

| Surface | Browser responsibility | Durable/runtime authority | Status |
| --- | --- | --- | --- |
| Documents/editor | render, filter, edit buffer | `document.*` and authoritative snapshots | migrated |
| Import and batches | file selection, parsing, progress UI | `workspace.transaction` | migrated commit path |
| Undo/redo | labels and buttons | inverse control-plane transactions | migrated for documents |
| Graph list/workspaces | selector and responsive UI | `graph.workspace.*` | migrated |
| Graph membership/view | Cytoscape projection and animation | `graph.workspace.put` transaction | migrated |
| Drag/layout | live frames local | debounced final graph commit | migrated |
| Selection/menus | transient interaction | browser only | intentionally local |
| PouchDB views | CouchDB sync staging only | populated only for explicit synchronization | transitional adapter |
| CouchDB sync | browser connection UI and staging | pulled records commit through Lisp / owning backend | transitional adapter |
| Settings/themes | controls and presentation | browser settings store | transitional; export filtered |
| Actors/research/targets | UI, progress, capability state | Quasar runtime or owning StarIntel actor service | transitional |
| StarIntel Server | status/search/ingest presentation | `starintel-server` capability-specific adapters | transitional |
| BBPD | availability, target controls, logs/results | external `star-bbpd` through StarIntel routing/adapters | transitional |
| RabbitMQ/Brave/URL/MCP | browser presentation and current adapters | owning runtime/service capability | transitional |
| StarLang | editor/results UI | capability-gated Common Lisp | Lisp-only |
| PWA/install | install/cache UX | browser | intentionally local |

## Service capability rule

Runtime-backed and external-service rows describe UI bindings, not browser
ownership. `starintel-server` may own ingest, persistence, search and queue
routing. `star-bbpd` owns its external Python/Pykka recon workers and native
tools. Quasar Common Lisp owns canonical command/revision authority and
persistent supervision for migrated operations. The browser renders controls,
progress, logs, documents, graph projections and errors.

The UI must discover capabilities. A missing backend or external service reduces
only its dependent controls; it must not silently fall back to weaker browser
semantics while claiming equivalent capability.

## Migration rules

- Migrated document and graph operations fail visibly when the control plane is
  unavailable; they never fall back to PouchDB.
- Authoritative snapshots initialize and restore durable UI state.
- Optimistic graph presentation commits refresh or roll back from the snapshot
  on failure.
- CouchDB pull data is staging input and must pass canonical validation and a
  Lisp transaction before it appears in authoritative state.
- Credentials remain outside document/graph envelopes, settings export strips
  them, and audit records never include payloads.
- Privileged/native service execution remains behind the runtime or owning
  external-service boundary.

## Non-regression gates

- all existing routes and visible desktop/mobile features remain present;
- mobile navigation, graph selector, right-click menus, fullscreen graph,
  actors, themes, and settings transfer remain usable;
- Cytoscape remains a projection;
- selection and high-frequency viewport interaction remain browser-local;
- Playwright runs against the real Lisp/Vite stack and proves create, graph
  membership, reload, and authoritative restore;
- unavailable `starintel-server`, BBPD, or other service capabilities fail
  closed without being mislabeled as browser-provided equivalents.

## Remaining migration order

1. Move settings commits and secret-bearing network configuration behind
   capability-checked commands.
2. Move actor/research lifecycle and target submission to supervised Lisp actors
   or the owning StarIntel service while preserving browser-safe standalone
   actions.
3. Move CouchDB, RabbitMQ, StarIntel Server, BBPD, Brave, URL, MCP, and skill
   integrations behind capability-checked control-plane/service adapters.
4. Replace the development memory store with a process-durable implementation
   of the existing atomic store interface.
5. Add capability-matrix tests proving unavailable backend/external services
   disable only their dependent UI and do not break standalone editing.
