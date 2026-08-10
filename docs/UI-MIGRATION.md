# Quasar UI binding ledger

The `frontend/` submodule preserves the current UI. Migration changes its data
and action adapters, not its visible feature set.

The browser is a presentation and interaction layer. A visible control for a
runtime or external service does **not** make that service a browser
implementation. Connected Quasar discovers available capabilities from the
Common Lisp runtime and StarIntel service layer; unavailable services remain
unavailable rather than being silently replaced with weaker JavaScript
semantics.

See [`CAPABILITY-BOUNDARY.md`](CAPABILITY-BOUNDARY.md) for the full
`quasar-ui -> quasar -> starintel-server -> external services` split.

| UI surface | Browser responsibility | Runtime/service command or event |
| --- | --- | --- |
| Dashboard/statistics | render cards and charts | `projection.stats.query` |
| Global search | input, suggestions, result presentation | `search.query`, `search.cancel` |
| Graph list/workspaces | selector, responsive/mobile menu | `graph.list`, `graph.create`, `graph.rename`, `graph.delete` |
| Graph canvas | Cytoscape rendering and transient interaction | `graph.snapshot`, `graph.operation.apply` |
| Drag/layout/viewport | animation and frames stay local | final `graph.view.commit` |
| Right-click menus | menu rendering and action search | `action.list-applicable`, `action.invoke` |
| Cross-dataset links | gesture and editor | `relation.create` with provenance |
| Documents/table | render, sort, filter controls | `document.query`, `document.get` |
| Document editor | local form buffer | `document.save`, `document.remove` |
| Import | file selection and progress UI | `import.stage`, `import.commit`, `import.abort` |
| Undo/redo | buttons and labels | `transaction.undo`, `transaction.redo` |
| Datasets | routes and forms | `dataset.list`, `dataset.save`, `dataset.remove` |
| Agents | console, bubble, status controls | `actor.list`, `actor.run`, `actor.pause`, `actor.resume`, `actor.stop` |
| Research nodes | node UI and progress | `research.run`, `research.pause`, `research.resume`, `research.retry`, `research.kill` |
| Targets | target form and capability state | `target.submit` |
| StarIntel Server | backend status/search/ingest presentation | capability-specific server adapter commands/events |
| BBPD | service availability, target controls, progress/log/result presentation | external `star-bbpd` capability through StarIntel routing/adapters |
| CouchDB | status and controls | `sync.start`, `sync.stop`, `sync.once` |
| RabbitMQ | status and counters | `queue.start`, `queue.stop`; delivery events |
| Brave search | query/results UI | `tool.brave.search` |
| URL grab | URL input and extraction display | `tool.url.fetch` |
| MCP/skills | configuration and invocation UI | `mcp.*`, `skill.*` |
| StarLang | editor/results UI | `starlang.status`, `starlang.load`, later compile/run |
| Settings | controls and ten auto-dig themes | `settings.get`, `settings.patch` |
| Settings import/export | file UI; never export credentials | `settings.export-safe`, `settings.import-safe` |
| Mobile navigation | swipe/tap sheet and three-bar button | no RPC |
| Mobile graph selector | compact dropdown, no nested scrolling | `graph.list`, `graph.switch` |
| Full viewport graph | layout and fullscreen presentation | committed view state only |
| PWA/install | browser install/cache UX | capability/status events only |

## Service capability rule

Runtime-backed and external-service rows in this ledger describe **UI bindings**.
They do not grant the browser implementation ownership of the service.

Examples:

- `starintel-server` may own document ingest, persistence, search, CouchDB and
  RabbitMQ routing.
- `star-bbpd` runs external Python/Pykka workers and native recon tools such as
  Subfinder, Nmap, Httpx and Katana.
- Quasar Common Lisp owns canonical command/revision authority and persistent
  runtime supervision for migrated operations.
- Quasar UI renders controls, progress, logs, documents, graph projections and
  errors for those capabilities.

The browser must use capability discovery to decide which controls are enabled.
A disconnected standalone edition may continue to provide browser-safe local
features without claiming service parity.

## Migration order

1. Import `frontend-overlay/src/lib/control-plane.js` and add the browser transport adapter without changing presentation.
2. Replace direct durable database writes with command calls for migrated subjects.
3. Move persistent actor/research/target execution to the control plane or owning StarIntel service while preserving browser-safe standalone actions.
4. Move CouchDB, RabbitMQ, StarIntel Server, BBPD, Brave, URL, MCP, skills, and StarLang integrations behind capability-checked commands/adapters.
5. Add reconnect, replay, optimistic transaction IDs, and deterministic conflict presentation.
6. Remove browser-held credentials and privileged network paths that belong to runtime/service layers.
7. Add integration and Playwright parity tests proving every existing route and mobile interaction remains available.
8. Add capability-matrix tests proving unavailable backend/external services disable only their dependent UI and do not break standalone editing.

## Non-regression gates

- no route or visible feature may be deleted during adapter migration;
- desktop layout remains unchanged by mobile work;
- mobile navigation keeps both swipe/tap access and the visible three-bar button;
- graph selector remains a compact dropdown without nested scrolling;
- right-click menus, graph lists, cross-dataset links, fullscreen graph, fast
  zoom, agents, themes, and settings import/export remain present;
- settings exports strip credentials and tokens;
- Cytoscape remains a projection, never the canonical database;
- a service control does not execute privileged/native service code in the browser;
- missing `starintel-server`, BBPD, or other external capabilities fail closed
  without being mislabeled as browser-provided equivalents.
