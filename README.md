# Quasar

Quasar is a self-contained monorepo containing the complete React/Vite UI, the
Common Lisp control plane, the CLOG host, and StarLang integration. No submodule
or separate repository clone is required.

## Architecture

```text
frontend/ (React/Vite/Cytoscape, tracked files)
  frontend/src/control-plane/  ← typed WebSocket client (client.ts, protocol.ts, events.ts, reconnect.ts)
        |
        | quasar.control.v1 command/event envelopes over WebSocket
        v
Quasar Common Lisp control plane
  control-plane/src/protocol.lisp     ← v1 envelope decode/encode, stable error codes
  control-plane/src/workspace.lisp    ← canonical workspace state, documents, graphs, nodes, edges
  control-plane/src/store.lisp        ← persistence boundary (in-memory default, CouchDB-ready)
  control-plane/src/control-plane.lisp ← Sento single-writer actor, command dispatch, events
  control-plane/src/websocket-server.lisp ← typed WebSocket transport
  control-plane/src/clog-host.lisp    ← CLOG static host (session lifecycle)
  control-plane/src/starlang-adapter.lisp ← restricted StarLang adapter
  systems/quasar-*.asd                ← ASDF system definitions
        |
        +-- single-writer actor
        +-- canonical workspace state (documents, graphs, nodes, edges)
        +-- command registry and capability discovery
        +-- atomic transactions with rollback
        +-- authoritative event broadcast
        +-- StarLang adapter
        +-- future CouchDB/RabbitMQ/Brave/MCP adapters
```

CLOG hosts the browser session and serves static assets. It does **not** recreate
every React component as a CLOG object. The typed WebSocket server is the command
transport. High-frequency graph interaction (drag, zoom, pan) remains in
Cytoscape; committed operations cross to Lisp.

## Repository layout

```text
quasar/
├── frontend/             ← React/Vite/Cytoscape UI (tracked files, no submodule)
│   ├── src/
│   │   ├── control-plane/ ← typed WS client (client.ts, protocol.ts, events.ts, reconnect.ts, adapters.ts)
│   │   ├── app/           ← main.tsx imports initializeControlPlane() directly
│   │   ├── components/    ← graph, mobile, agents, research, etc.
│   │   ├── lib/           ← db, operations, graph-workspaces, actors, etc.
│   │   └── ...
│   ├── package.json
│   ├── vite.config.ts
│   └── ...
├── control-plane/         ← Common Lisp sources
│   ├── src/               ← protocol, workspace, store, control-plane, websocket-server, clog-host, starlang
│   └── tests/             ← control-plane tests
├── systems/               ← ASDF system definitions
│   ├── quasar-control.asd
│   ├── quasar-web.asd
│   ├── quasar-starlang.asd
│   └── quasar-tests.asd
├── scripts/               ← dev runner, test-lisp, run-control-plane, run-production
├── static/                ← CLOG static assets
├── docs/                   ← architecture and UI migration ledger
├── flake.nix               ← Nix development environment
├── package.json            ← root monorepo commands
└── README.md
```

## Quick start

```sh
git clone https://github.com/lost-rob0t/quasar.git
cd quasar

# Development shell (NixOS or Nix)
nix develop

# Install frontend dependencies
npm install

# Start the full development stack (Lisp control plane + WebSocket + CLOG + Vite)
npm run dev

# Or run individual pieces
./scripts/run-control-plane   # Lisp control plane + WS + CLOG
cd frontend && npx vite         # Vite dev server only
```

## Root commands

```bash
npm run dev       # Start all services (supervised, signal-forwarding)
npm run build     # Build the frontend for production
npm run test      # Run Lisp + frontend tests
npm run test:lisp  # Run Lisp tests only
npm run typecheck  # TypeScript typecheck
npm run lint       # ESLint
npm run format     # Prettier
```

## Protocol

Every command is a JSON object with the `quasar.control.v1` protocol:

```json
{
  "protocol": "quasar.control.v1",
  "id": "unique-request-id",
  "command": "graph.node.create",
  "payload": {},
  "metadata": {
    "client": "quasar-ui",
    "workspace": "workspace-id"
  }
}
```

Successful response:

```json
{
  "protocol": "quasar.control.v1",
  "id": "unique-request-id",
  "status": "ok",
  "result": {}
}
```

Error response:

```json
{
  "protocol": "quasar.control.v1",
  "id": "unique-request-id",
  "status": "error",
  "error": {
    "code": "graph.invalid-reference",
    "message": "The referenced node does not exist.",
    "details": {}
  }
}
```

### Implemented commands

- `system.capabilities`
- `workspace.snapshot`
- `workspace.transaction`
- `document.list`, `document.get`, `document.create`, `document.update`, `document.delete`
- `graph.snapshot`
- `graph.node.create`, `graph.node.update`, `graph.node.delete`
- `graph.edge.create`, `graph.edge.update`, `graph.edge.delete`
- `starlang.status`, `starlang.load`

### Authoritative events

- `workspace.revision.changed`
- `document.created`, `document.updated`, `document.deleted`
- `graph.node.created`, `graph.node.updated`, `graph.node.deleted`
- `graph.edge.created`, `graph.edge.updated`, `graph.edge.deleted`

Each event includes protocol, event name, workspace ID, revision, operation ID,
and payload. All connected clients (including the initiator) receive events. The
frontend deduplicates by operation ID and revision.

## Frontend integration

The React app imports the control-plane client directly:

```typescript
import { initializeControlPlane } from "./control-plane";

initializeControlPlane();
```

The client is a typed WebSocket client in `frontend/src/control-plane/` with:

- Request correlation by ID
- Command timeout
- Bounded exponential backoff reconnection
- Event subscription with deduplication by operation ID and revision
- Optimistic update + rollback helpers
- Adapters for document and graph CRUD

## Persistence boundary

The control plane owns durable state through a store abstraction:

```lisp
(defgeneric load-workspace (store workspace-id))
(defgeneric save-workspace (store workspace))
(defgeneric append-operation (store workspace-id operation))
```

The default in-memory implementation is suitable for development and tests.
CouchDB integration replaces the implementation, not the protocol.

## Current slice

Implemented:

- Complete React UI as tracked files (no submodule)
- v1 protocol envelope with structured ok/error and stable error codes
- Sento single-writer actor; all mutations through the actor
- Document CRUD, graph node/edge CRUD
- Atomic `workspace.transaction` with isolated candidate state and rollback
- Authoritative event broadcast to all clients
- Typed WebSocket server (websocket-driver)
- Typed WebSocket client in the frontend (client.ts, reconnect, events, adapters)
- Direct `initializeControlPlane()` import in `main.tsx`
- Store abstraction with in-memory default (CouchDB-ready)
- Monorepo CI assertions (no submodule, no overlay, no injection script)
- Nix development environment (SBCL, Node, OpenSSL, Chromium)
- Root `npm run dev` supervised dev stack

Remaining (documented transitional adapters):

- Actor and research lifecycle → control-plane actors
- Import/commit/abort with progress events
- CouchDB sync adapter
- RabbitMQ ingest adapter
- Brave search, URL retrieval, MCP adapters
- StarLang compile/load/run contracts
- Full Playwright parity coverage
- Frontend mutation adapters wiring into store.jsx

The complete UI binding ledger is in [`docs/UI-MIGRATION.md`](docs/UI-MIGRATION.md).
