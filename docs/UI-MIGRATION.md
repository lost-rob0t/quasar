# Quasar UI binding ledger

The migration changes data/action ownership without replacing the React and
Cytoscape presentation layer or removing visible routes.

| Surface | Browser responsibility | Durable authority | Status |
| --- | --- | --- | --- |
| Documents/editor | render, filter, edit buffer | `document.*` and authoritative snapshots | migrated |
| Import and batches | file selection, parsing, progress UI | `workspace.transaction` | migrated commit path |
| Undo/redo | labels and buttons | inverse control-plane transactions | migrated for documents |
| Graph list/workspaces | selector and responsive UI | `graph.workspace.*` | migrated |
| Graph membership/view | Cytoscape projection and animation | `graph.workspace.put` transaction | migrated |
| Drag/layout | live frames local | debounced final graph commit | migrated |
| Selection/menus | transient interaction | browser only | intentionally local |
| PouchDB views | CouchDB sync staging only | populated only for explicit synchronization | transitional adapter |
| CouchDB sync | browser connection UI and staging | pulled records commit through Lisp | transitional adapter |
| Settings/themes | controls and presentation | browser settings store | transitional; export filtered |
| Actors/research/targets | UI and current browser runtimes | mixed | transitional |
| RabbitMQ/Brave/URL/MCP | current browser adapters | mixed | transitional |
| StarLang | editor/results UI | capability-gated Common Lisp | Lisp-only |
| PWA/install | install/cache UX | browser | intentionally local |

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

## Non-regression gates

- all existing routes and visible desktop/mobile features remain present;
- mobile navigation, graph selector, right-click menus, fullscreen graph,
  actors, themes, and settings transfer remain usable;
- Cytoscape remains a projection;
- selection and high-frequency viewport interaction remain browser-local;
- Playwright runs against the real Lisp/Vite stack and proves create, graph
  membership, reload, and authoritative restore.

## Remaining migration order

1. Move settings commits and secret-bearing network configuration behind
   capability-checked commands.
2. Move actor/research lifecycle and target submission to supervised Lisp
   actors.
3. Move CouchDB, RabbitMQ, Brave, URL, MCP, and skill execution behind control
   plane adapters while preserving their existing UI.
4. Replace the development memory store with a process-durable implementation
   of the existing atomic store interface.
