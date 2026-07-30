# Quasar

Quasar is the Common Lisp control plane and CLOG WebSocket host for the existing
Quasar investigation workspace.

The browser UI is preserved as the `frontend/` git submodule, pinned to
`lost-rob0t/quasar-ui`. React, Cytoscape, the mobile shell, documents, graphs,
datasets, imports, settings, themes, agents, research nodes, statistics, and the
PWA remain browser features. Durable or privileged operations move behind one
versioned command channel owned by Common Lisp.

## Architecture

```text
quasar-ui (React/Vite/Cytoscape)
        |
        | versioned command envelopes
        | carried over the CLOG WebSocket bridge
        v
Quasar Common Lisp control plane
        |
        +-- single-writer actor
        +-- canonical workspace state
        +-- command registry and capability discovery
        +-- StarLang adapter
        +-- future CouchDB/RabbitMQ/Brave/MCP adapters
```

CLOG hosts the browser session and transports commands. It does **not** recreate
every React component as a CLOG object. High-frequency graph interaction remains
inside Cytoscape; committed operations cross to Lisp.

## Checkout

```sh
git clone --recurse-submodules https://github.com/lost-rob0t/quasar.git
cd quasar
bash scripts/prepare-frontend.sh
```

The frontend submodule is pinned so the full UI does not silently drift. The
preparation script copies the control-plane client into the pinned frontend and
adds one side-effect import to `src/app/main.tsx`; it does not remove or replace
any existing component.

## Run the UI during migration

Start the preserved frontend:

```sh
cd frontend
npm ci
npm run dev
```

Then start the Common Lisp host:

```lisp
(ql:quickload '(:clog :jsown :sento))
(asdf:load-system :quasar)
(quasar.app:start
 :frontend-url "http://127.0.0.1:5173/quasar-ui/"
 :host "127.0.0.1"
 :port 8080)
```

Open `http://127.0.0.1:8080`. The React application is hosted in a full-viewport
frame. `frontend/src/lib/control-plane.js` uses `postMessage` when the Vite dev
server is cross-origin and the direct host API when production is same-origin.

## Browser API

Inside the frontend:

```js
await window.QuasarControlPlaneClient.capabilities();
await window.QuasarControlPlaneClient.snapshot();
await window.QuasarControlPlaneClient.apply({
  type: "document.save",
  payload: { _id: "person:1", dtype: "person", name: "Example" }
});
await window.QuasarControlPlaneClient.starlangStatus();
```

Inside the CLOG host window the equivalent API is
`window.QuasarControlPlane`.

## Current slice

Implemented:

- exact Quasar UI preserved as a pinned submodule;
- idempotent frontend bridge injection at the real UI bootstrap;
- CLOG browser/session host;
- structured command/result/event protocol v1;
- single-writer Sento control-plane actor;
- in-memory canonical workspace with document, graph, and settings operations;
- capability discovery;
- optional StarLang command registration;
- tests and CI.

The complete UI binding ledger is in [`docs/UI-MIGRATION.md`](docs/UI-MIGRATION.md).
