# Frontend package architecture

The root [architecture](../../docs/ARCHITECTURE.md) is authoritative: Common
Lisp owns durable workspace state and browser databases are projections. This
document records only the frontend-specific presentation and package boundary.

## Presentation responsibilities

React owns routes, forms, panels, responsive layouts, settings UI, and notices.
Cytoscape owns rendering and high-frequency interaction. Selection, hover,
menus, drafts, pan/zoom frames, and layout animation remain local. Final graph
view commits cross the control plane.

The graph projection maps canonical non-relation documents to nodes and
relation documents to edges; unresolved endpoints remain visible placeholders.
Named graph membership and committed positions/view metadata come from the
authoritative Lisp snapshot.

## Durable adapter

`src/control-plane` provides command correlation, connection state, bounded
reconnect, fresh-snapshot recovery, per-workspace revision/event handling, and
document/graph commands. `QuasarProvider` is the UI integration point. Migrated
operations do not call direct PouchDB mutation helpers or fall back when the
control plane is unavailable.

PouchDB supplies local map/reduce query projections and CouchDB staging. A Lisp
snapshot replaces the local projection. Pulled CouchDB documents are input to a
validated control-plane transaction before they become authoritative.

## Dependency direction

The enforced package direction is described by
[ADR 0001](adr/0001-js-package-boundaries.md). React and integrations may depend
on core/control-plane services; core graph and identifier modules do not depend
on React, Cytoscape, PouchDB, or optional network integrations.

## Existing browser integrations

Browser actors, provider adapters, RabbitMQ Web STOMP, Brave/URL/MCP tooling,
and local settings remain transitional features. They produce declarative
document/graph operations that enter through `QuasarProvider`. Moving their
execution and credential-bearing configuration behind Common Lisp capabilities
is tracked in the root migration ledger.

## Deployment

Vite builds for `/`. CLOG serves `frontend/dist`, hashed assets, and the same
`index.html` for SPA routes. Manifest and service-worker URLs share the root
scope. Playwright starts the real Vite/CLOG/WebSocket/control-plane stack rather
than a backend-free static approximation.
