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
```

The frontend submodule is pinned so the full UI does not silently drift.

## Run the UI during migration

Build or run the frontend independently, then point the CLOG host at it:

```lisp
(ql:quickload '(:clog :jsown :sento))
(asdf:load-system :quasar)
(quasar.app:start
 :frontend-url "http://127.0.0.1:5173/quasar-ui/"
 :host "127.0.0.1"
 :port 8080)
```

Open `http://127.0.0.1:8080`. The React application is hosted in a full-viewport frame. Copy or import
`frontend-overlay/src/lib/control-plane.js` during the frontend adapter migration;
it uses `postMessage` when the Vite dev server is cross-origin and the direct host
API when production is same-origin.

## Browser API

```js
await window.QuasarControlPlane.capabilities();
await window.QuasarControlPlane.snapshot();
await window.QuasarControlPlane.apply({
  type: "document.save",
  payload: { _id: "person:1", dtype: "person", name: "Example" }
});
await window.QuasarControlPlane.starlangStatus();
```

## Current slice

Implemented:

- exact Quasar UI preserved as a pinned submodule;
- CLOG browser/session host;
- structured command/result/event protocol v1;
- single-writer Sento control-plane actor;
- in-memory canonical workspace with document, graph, and settings operations;
- capability discovery;
- optional StarLang command registration;
- tests and CI.

The complete UI binding ledger is in [`docs/UI-MIGRATION.md`](docs/UI-MIGRATION.md).
