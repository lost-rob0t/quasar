# Quasar UI

Quasar is a browser-first, offline-first StarIntel investigation workspace. It follows the graph-document and reversible-operation boundaries from the Quasar designs in `starintel-auto-research`, while replacing the earlier CLOG/backend-first prototype assumption with a full JavaScript client.

The [JavaScript-only deployment roadmap](docs/ROADMAP.md) defines the target architecture, dependency order, phase gates, and production-readiness decision. [ADR 0001](docs/adr/0001-js-package-boundaries.md) defines and enforces the package dependency direction. The implementation list below describes the current prototype and does not supersede the roadmap's IndexedDB-based target.

## Current implementation

- strict TypeScript application entrypoint and package contracts
- React and Vite application shell
- Cytoscape investigation graph with Maltego-style selection and relationship navigation
- hierarchical canvas, node, edge, and multi-selection context menus with action search
- PouchDB canonical local corpus
- separate PouchDB workspace/settings store
- versioned CouchDB-compatible map-reduce views
- optional push, pull, one-shot, or live CouchDB replication
- optional starintel-server capability probing and target submission
- optional RabbitMQ Web STOMP ingestion into local PouchDB and the active graph
- canonical StarIntel v0.9 validation through `starintel_doc.js`
- graph-created documents and relations
- multiple saved graph workspaces with independent membership, layout, viewport, and selection
- standalone manual document adder/editor
- stable single-document routes at `/documents/:id`
- searchable/filterable table view
- single-file upload
- bulk multi-file upload
- JSON, JSONL, NDJSON, and CSV import
- save-and-open graph navigation for newly imported records
- dataset and actor manifest file resolution
- statistics dashboard
- JSONL export
- transaction-level undo and redo
- connection path finder
- opt-in custom browser actors executed in Web Workers
- persistent operator agents with editable roles and scoped memory
- OpenRouter, OpenAI, Anthropic, OpenAI-compatible, and local provider adapters
- permissioned database, graph, actor, and graph-mutation tools
- Brave web search, bounded URL extraction, and remote MCP tools
- persistent per-agent skills and MCP server assignments
- direct custom graph building from document IDs or database queries
- persisted autonomous runs with checkpoints, recovery, loop detection, budgets, and cost logs
- draggable desktop/mobile agent bubble and full run console
- runtime service worker for offline reopening
- GitHub Actions CI and Pages deployment

## Data boundary

Quasar stores canonical StarIntel documents directly in `quasar-starintel-v09`.
The graph is a projection of that local corpus: it hydrates on startup and refreshes from the PouchDB changes feed. Import navigation carries only selection/focus state and does not create a second graph document store.

Quasar-only state is stored separately in `quasar-ui-state-v1`:

- graph positions
- viewport
- selected nodes
- layout choice
- saved graph definitions and active graph
- CouchDB settings
- StarIntel server and RabbitMQ Web STOMP settings
- browser actor manifests

Only the StarIntel corpus database is replicated to CouchDB. UI state does not contaminate the StarIntel schema.

Quasar installs versioned `_design/starintel-*-v1` documents into the canonical
corpus. Those views replicate to CouchDB, so local PouchDB and remote CouchDB
queries share keys and reduce behavior. The statistics dashboard reads its
review, dtype, and dataset distributions through these views.

The initial **All documents** graph dynamically projects the complete local corpus. Additional graphs start blank and store only document IDs plus graph-local view state; creating or deleting a graph never duplicates or deletes canonical corpus documents.

## Routes

```text
/graph
/documents
/documents/new
/documents/:id
/documents/:id/edit
/import
/stats
/settings
/agents
```

The Pages build includes `404.html` as an SPA fallback so direct document routes remain loadable.

## Development

From a clean checkout, install the pinned dependencies and start the local
application at `http://localhost:5173` with one command:

```bash
npm ci && npm run dev
```

The individual validation and production commands are:

```bash
npm ci
npm run dev
npm run check
npm run typecheck
npm run check:boundaries
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

Node.js 22.12 or newer and the committed npm lockfile define the reproducible
toolchain. `npm run check` includes strict TypeScript validation plus syntax
checks for the static service-worker runtime.

Development and production builds use root hosting by default. Set
`VITE_BASE_PATH` to an absolute URL path when deploying below a site root:

```bash
VITE_BASE_PATH=/quasar-ui/ npm run build
```

The Pages workflow builds with `VITE_BASE_PATH=/` because the configured
`quasar.starintel.actor` custom domain serves the project at its origin root.
The same normalized base path configures Vite assets, React Router, the web
manifest, and service worker registration, so no backend or runtime URL
rewriting is required.

The TypeScript package entrypoints establish the intended dependency areas:

```text
src/app
src/core
src/storage
src/graph
src/actions
src/projections
src/integrations
src/components
src/testing
```

Existing JavaScript feature modules remain available behind those entrypoints
while they are migrated incrementally; new package contracts and the browser
entrypoint are type-checked with `strict: true`.

The application pins the tested v0.9 runtime commit from `starintel_doc.js`:

```text
github:lost-rob0t/starintel_doc.js#108310c1bcee403cb7e40dabfd3547a6b5228c51
```

The dependency and this documented revision must stay aligned so import diagnostics identify the validator actually bundled into the application.

## Import conventions

- `.json`: one document, an array, or an object containing `documents`/`docs`
- `.jsonl` and `.ndjson`: one document per line
- `.csv`: common envelope columns plus `data` JSON or `data.<field>` columns
- StarIntel document imports: manifest records are stored as documents; their file references are not followed
- bundle manifest imports: enable **Treat manifests as bundle instructions** and select every referenced file in the same bulk file picker

Imports are atomic by default: every candidate and duplicate ID is checked before PouchDB writes. A failed PouchDB bulk result triggers compensating rollback, and the report preserves file, record, validation-path, and write-phase details. Existing IDs are replaced only when explicitly requested or when the incoming version/date is newer.

Import reports also show the active `starintel_doc` schema revision and profile. Production navigation is network-first, while content-hashed assets remain cache-first; service-worker update checks bypass the HTTP cache and replace an obsolete application shell on reload.

## Browser actors

Bundled actors are available by default; user-supplied actor code is disabled until explicitly enabled. An actor manifest contains:

```json
{
  "id": "quasar.actor.example",
  "label": "Example actor",
  "description": "Update the selected document.",
  "version": 1,
  "accepts": ["org", "person"],
  "minSelection": 1,
  "maxSelection": 1,
  "source": "(context) => ({ operations: [{ op: 'update_document', document: { ...context.selection[0], title: 'Updated' } }], message: 'Updated selection' })"
}
```

Actors receive cloned selection and corpus data. They return declarative transform plans rather than mutating Cytoscape or PouchDB directly. Supported operations are `create_document`, `update_document`, `upsert_document`, `remove_document`, `create_relation`, and `remove_relation`.

Quasar validates the entire plan, checks create/update/remove preconditions against a projected corpus, and applies it as one undoable batch through the same mutation path as manual edits. Legacy actors that return `documents` remain compatible; each returned document is treated as an `upsert_document` transform.

The first built-ins generate username candidates from person/entity names and prepare `whatsmyname.app` enumeration links for existing or generated usernames. The live WhatsMyName check opens in its browser application because cross-origin profile sites cannot be reliably verified from a Quasar Web Worker.

## Agents

The floating agent bubble opens a bounded command panel from any route. The
full `/agents` console manages agents, reusable roles, provider connections,
structured memory, runs, tool logs, checkpoints, loop warnings, usage, and
cost.

Agents query the StarIntel database and graph through declared permissioned
tools. They can search with Brave, fetch public URL content, call assigned MCP
servers, build saved graphs, run existing actors, test generated actors in Web
Workers, and apply validated graph plans through the normal history and undo
path. Provider, Brave, and MCP keys remain session-scoped and are excluded from
stored records and normal JSON exports.

See [Agent system](docs/AGENT_SYSTEM.md) for provider, tool, permission, state
machine, recovery, loop detection, budget, context, and actor-generation
contracts.

## StarIntel server and queue ingest

The optional server adapter probes `/api/v1/capabilities` first. Until the
expanded API is available, it falls back to current gserver metadata and
`/new/target/:actor`. Submitted targets are canonical v0.9 target documents and
are saved locally only after the server accepts them.

The optional RabbitMQ listener uses Web STOMP. Deliveries may be a document, an
array, `{ "document": ... }`, or `{ "documents": [...] }`. Every batch passes
canonical validation and idempotent PouchDB persistence before its IDs are
added to the active graph. Accepted and already-current documents are
acknowledged; invalid deliveries are negatively acknowledged without requeue
to avoid poison-message loops.
