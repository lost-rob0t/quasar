# ADR 0001: JavaScript package boundaries

- Status: Accepted
- Date: 2026-07-26
- Decision owner: Quasar UI maintainers
- Roadmap issue: [#4](https://github.com/lost-rob0t/quasar-ui/issues/4)

## Context

Quasar is a browser-first, offline-first application. Canonical StarIntel documents and reversible graph commands must remain independent from React, Cytoscape, browser storage, network transports, and optional integrations. Renderer state is a projection and cannot become a second canonical database.

The repository contains typed package entrypoints plus legacy JavaScript feature modules. These entrypoints define the dependency direction while legacy modules are migrated behind them.

## Decision

The application is split into these zones:

| Zone           | Responsibility                                               | May depend on                             |
| -------------- | ------------------------------------------------------------ | ----------------------------------------- |
| `core`         | Canonical types, command values, validation contracts        | nothing platform-specific                 |
| `storage`      | Local canonical persistence and workspace persistence        | `core`                                    |
| `graph`        | `GraphAdapter`, layouts, renderer translation                | `core`                                    |
| `actions`      | Reversible commands, batches, actors, worker plans           | `core`                                    |
| `projections`  | Pure graph, table, statistics, map, and timeline projections | `core`                                    |
| `integrations` | Optional server, CouchDB, queue, and provider adapters       | `core`, `actions`                         |
| `components`   | Generic UI and view components                               | `core`, `graph`, `actions`, `projections` |
| `app`          | Composition, routing, providers, feature wiring              | every runtime zone except `testing`       |
| `testing`      | Fixtures and test-only helpers                               | any zone                                  |

Dependencies point downward toward `core`. A lower zone cannot import a UI or composition zone. Package implementation files cannot reach into `src/lib`; a package `index.ts` may temporarily bridge one legacy module while that module is migrated.

### Graph adapter

Only `src/graph/GraphAdapter.js` may import Cytoscape or Cytoscape plugins. It owns renderer construction and plugin registration. Components request the renderer through the adapter factory and never initialize it directly. The factory preserves Cytoscape object identity because renderer event targets rely on identity equality. Renderer objects never persist canonical documents.

### Mutation boundary

Durable changes are command values: save, remove, or atomic batch. Manual forms, graph gestures, imports, actors, queue delivery, and integrations must submit commands through the action pipeline. No component, renderer callback, plugin, or integration may mutate the canonical database directly.

High-frequency transient state such as pointer movement and layout frames remains renderer-local. A final gesture may commit graph-local view state through the workspace command path.

### Storage and integration boundary

Canonical local state and Quasar workspace state are separate. Remote responses, broker deliveries, provider output, and projection caches are not canonical until validated and committed through a command.

Integrations are optional leaves. `core`, the local editor, graph projection, and storage packages cannot import them. Removing an integration package must not break local document editing.

### Prohibited architecture

Quasar does not add:

- Common Lisp or Node API business logic to the browser application;
- Rust or Tauri runtime requirements;
- GraphQL or Socket.IO transports;
- renderer-owned persistence;
- direct plugin mutation of canonical graph data;
- network access from `core`;
- direct Cytoscape imports outside `GraphAdapter`.

## Enforcement

`npm run check:boundaries` scans static, re-exported, side-effect, and literal dynamic imports. CI runs it through `npm run check`. Regression tests cover representative allowed and prohibited imports.

The scanner enforces typed package zones immediately and bans renderer imports across both typed and legacy feature code. Existing JavaScript feature modules retain temporary access to legacy helpers; new typed modules may bridge them only through package entrypoints. Each later migration reduces rather than expands that compatibility surface.

## Consequences

- Core contracts can run in Node-based tests without React, Cytoscape, IndexedDB, PouchDB, or network access.
- Renderer replacement and headless graph tests have one adapter boundary.
- Optional integrations cannot become implicit requirements of the local editor.
- Existing legacy modules require incremental migration behind their package entrypoints.
- New cross-zone dependencies must follow this ADR or replace it with a reviewed superseding decision.
