# Architecture

## Decision

Quasar uses a browser client plus a Common Lisp control plane.

The UI is not rewritten widget-by-widget in CLOG. That would destroy the current
React/Cytoscape interaction quality and flood the WebSocket with pointer and
layout frames. CLOG owns connection lifecycle, session identity, hosting, and the
bridge. The Common Lisp control plane owns durable state, authorization,
commands, actors, StarLang, adapters, and audit.

## Boundaries

### Browser-local

- React routing and component state
- Cytoscape paint, hover, pan, zoom, drag frames, layout animation
- open menus and dialogs
- temporary form buffers
- responsive/mobile presentation
- PWA cache and install UX

### Control-plane commands

- document save/remove/import commits
- graph definitions and committed positions/view state
- undo/redo transaction requests
- settings commits with secret filtering
- actor and research-node lifecycle
- target submission
- CouchDB synchronization
- RabbitMQ settlement
- Brave search and URL retrieval
- MCP and skill execution
- StarLang compile/load/run
- permissions, capabilities, audit, export policy

## Protocol

Every browser command is a JSON object:

```json
{
  "v": 1,
  "kind": "command",
  "id": "ui-l8f-1",
  "command": "workspace.apply",
  "payload": {
    "operation": {
      "type": "document.save",
      "payload": {"_id": "person:1", "dtype": "person"}
    }
  }
}
```

Every command receives exactly one result envelope. Asynchronous changes use
event envelopes. Unknown commands fail deterministically.

## Actor rule

The WebSocket callback never mutates canonical state. It validates the envelope
and sends one message to the control-plane actor. That actor is the initial
single writer. External adapters later get supervised actors with bounded
mailboxes; they return declarative results to the control plane.

## StarLang

StarLang remains Common Lisp-only. The adapter discovers `STAR-LANG.API`
dynamically so Quasar can boot without loading the compiler/runtime. Loading
StarLang adds commands; it never moves StarLang implementation into JavaScript.

## Security

Arbitrary Common Lisp is not loaded into the GUI process. Extensions declare
capabilities and should execute in supervised worker processes or containers.
The backend must enforce permissions for every view and command. Secrets remain
session-scoped and are excluded from settings export.
