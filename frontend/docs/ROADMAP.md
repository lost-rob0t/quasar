# JavaScript-only deployment roadmap

This document is the repository execution plan for [roadmap issue #2](https://github.com/lost-rob0t/quasar-ui/issues/2). The issue and its linked implementation issues own scope and acceptance criteria. The machine-readable [dependency manifest](roadmap.json) mirrors their dependency declarations and is validated in the test suite.

The roadmap describes the target architecture. Existing prototype behavior is not evidence that a roadmap item is complete: an item is complete only when its issue acceptance criteria are tested, merged, and the issue is closed. In particular, the prototype's PouchDB/CouchDB document corpus is a migration source, not the target canonical store.

## Fixed target

- TypeScript, React, and Vite comprise the application platform.
- IndexedDB is the only canonical local workspace store.
- Cytoscape.js is accessible only through a strict graph adapter.
- Manual edits, imports, and actions all emit validated, atomic graph-operation batches.
- Web Workers run local actions and expensive parsing or layout work.
- XState owns startup, interaction, connection, and action lifecycles.
- TanStack Query owns optional remote adapter state only.
- Optional StarIntel connectivity uses typed HTTP and native WebSocket adapters and fails closed.
- Dashboard, graph, map, table, and timeline surfaces are projections over stable graph identifiers.
- Production is a static, installable PWA.

There is no deployment path through a Common Lisp backend, Node business-logic API, Rust or Tauri shell, GraphQL, Socket.IO, renderer-owned persistence, or direct extension mutation of canonical graph state.

## Delivery policy

Work is admitted in dependency order from [roadmap.json](roadmap.json). Independent issues may proceed in parallel, but a pull request must not rely on an open dependency's unmerged implementation. Cross-phase work can start when its declared dependencies are complete; a phase is not declared complete until every issue in it is closed and its exit gate passes against a clean checkout.

Every implementation pull request must:

1. link its owning roadmap issue and state which dependency versions it was tested against;
2. preserve one canonical mutation path and the package boundaries established in phase 0;
3. include deterministic regression coverage at the lowest useful layer;
4. pass formatting, linting, strict type checking, unit and browser tests, and the production build;
5. update migrations, retained fixtures, diagnostics, and user documentation when their contracts change.

Status is derived from GitHub issue state. Similar prototype code, a merged partial implementation, or a checked box copied into documentation does not override an open issue.

## Migration from the prototype

The browser-first prototype is useful as interaction and import/export reference behavior, but it does not define the target data model. Migration proceeds through the same boundaries as new functionality:

1. phase 0 establishes enforceable TypeScript packages, validation, and deterministic fixtures;
2. phase 1 introduces the canonical graph document, atomic commands, revision history, and IndexedDB repository;
3. supported prototype data enters the graph core only through the canonical import and graph-operation pipeline;
4. phase 2 replaces direct renderer and persistence coupling with application services and the graph adapter;
5. phase 3 moves actors to bounded worker actions and replaces CouchDB replication with an optional typed StarIntel adapter;
6. phases 4 and 5 add projections and deployment behavior without introducing another canonical store.

No destructive in-place conversion is permitted. A storage migration must retain fixtures, validate the complete source before commit, use an atomic destination transaction, and preserve an export or recovery path until the migrated workspace is verified.

## Phases and gates

### Phase 0 — Foundation

| Issue                                                  | Deliverable                                   | Depends on |
| ------------------------------------------------------ | --------------------------------------------- | ---------- |
| [#3](https://github.com/lost-rob0t/quasar-ui/issues/3) | TypeScript/React/Vite workspace               | —          |
| [#4](https://github.com/lost-rob0t/quasar-ui/issues/4) | Package boundaries and architecture rules     | #3         |
| [#5](https://github.com/lost-rob0t/quasar-ui/issues/5) | Quality, test, and CI baseline                | #3         |
| [#6](https://github.com/lost-rob0t/quasar-ui/issues/6) | Deterministic fixtures and schema conformance | #3, #4, #5 |

Exit gate: a clean checkout builds and tests, architecture boundaries are enforceable, and deterministic fixtures exist.

### Phase 1 — Local-first graph core

| Issue                                                    | Deliverable                                  | Depends on      |
| -------------------------------------------------------- | -------------------------------------------- | --------------- |
| [#7](https://github.com/lost-rob0t/quasar-ui/issues/7)   | Canonical graph document and type registry   | #4, #6          |
| [#8](https://github.com/lost-rob0t/quasar-ui/issues/8)   | Graph commands and atomic batch engine       | #7              |
| [#9](https://github.com/lost-rob0t/quasar-ui/issues/9)   | Transaction undo/redo and revisions          | #8              |
| [#10](https://github.com/lost-rob0t/quasar-ui/issues/10) | IndexedDB repository and migrations          | #7, #9          |
| [#11](https://github.com/lost-rob0t/quasar-ui/issues/11) | Canonical JSON, GraphML, and CSV interchange | #6, #7, #8, #10 |

Exit gate: graphs can be created, edited through commands, saved offline, reopened, undone and redone, imported, and exported without a server.

### Phase 2 — Editable workbench MVP

| Issue                                                    | Deliverable                                       | Depends on         |
| -------------------------------------------------------- | ------------------------------------------------- | ------------------ |
| [#12](https://github.com/lost-rob0t/quasar-ui/issues/12) | Resizable investigation shell                     | #3, #10            |
| [#13](https://github.com/lost-rob0t/quasar-ui/issues/13) | Cytoscape graph adapter and extension loader      | #7, #8, #12        |
| [#14](https://github.com/lost-rob0t/quasar-ui/issues/14) | Node and edge editing gestures                    | #8, #9, #13        |
| [#15](https://github.com/lost-rob0t/quasar-ui/issues/15) | Typed node and edge inspector                     | #7, #8, #12, #14   |
| [#16](https://github.com/lost-rob0t/quasar-ui/issues/16) | Persisted layouts, viewport, selection, and views | #9, #10, #13, #14  |
| [#17](https://github.com/lost-rob0t/quasar-ui/issues/17) | Command palette, keymap, and navigation           | #12, #14, #15, #16 |

Exit gate: a user can open a workspace, create and connect typed nodes, edit properties, arrange the graph, save and reopen it, and operate the core editor by pointer or keyboard.

### Phase 3 — JavaScript actions and optional integrations

| Issue                                                    | Deliverable                                     | Depends on    |
| -------------------------------------------------------- | ----------------------------------------------- | ------------- |
| [#18](https://github.com/lost-rob0t/quasar-ui/issues/18) | Action registry and applicability               | #7, #14, #17  |
| [#19](https://github.com/lost-rob0t/quasar-ui/issues/19) | Sandboxed Web Worker action runner              | #18           |
| [#20](https://github.com/lost-rob0t/quasar-ui/issues/20) | Validated, undoable action batches              | #8, #9, #19   |
| [#21](https://github.com/lost-rob0t/quasar-ui/issues/21) | Action progress, cancellation, logs, and traces | #18, #19, #20 |
| [#22](https://github.com/lost-rob0t/quasar-ui/issues/22) | Optional StarIntel HTTP/WebSocket adapter       | #7, #18, #21  |

Exit gate: a local worker action can be discovered, invoked, cancelled, validated, applied, and undone while remote integration remains optional.

### Phase 4 — Investigation projections and dashboard

| Issue                                                    | Deliverable                                   | Depends on              |
| -------------------------------------------------------- | --------------------------------------------- | ----------------------- |
| [#23](https://github.com/lost-rob0t/quasar-ui/issues/23) | Virtualized table projection                  | #7, #12, #16            |
| [#24](https://github.com/lost-rob0t/quasar-ui/issues/24) | MapLibre adapter and layer registry           | #7, #12, #16            |
| [#25](https://github.com/lost-rob0t/quasar-ui/issues/25) | Timeline adapter and temporal filtering       | #7, #12, #16            |
| [#26](https://github.com/lost-rob0t/quasar-ui/issues/26) | Shared selection, filters, and time           | #13, #23, #24, #25      |
| [#27](https://github.com/lost-rob0t/quasar-ui/issues/27) | Dashboard manifests, panels, and layouts      | #12, #23, #24, #25, #26 |
| [#28](https://github.com/lost-rob0t/quasar-ui/issues/28) | Projection coordinator and refresh scheduler  | #22, #23, #24, #25, #27 |
| [#29](https://github.com/lost-rob0t/quasar-ui/issues/29) | CodeMirror and optional Star-Lang integration | #7, #11, #17, #22       |
| [#30](https://github.com/lost-rob0t/quasar-ui/issues/30) | Evidence and document inspection              | #10, #15, #22, #26      |

Exit gate: graph, table, map, timeline, dashboard, editor, and document views coordinate through stable identifiers without creating duplicate canonical stores.

### Phase 5 — Production deployment

| Issue                                                    | Deliverable                                    | Depends on                                 |
| -------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| [#31](https://github.com/lost-rob0t/quasar-ui/issues/31) | Installable offline PWA                        | #10, #12, #16, #27                         |
| [#32](https://github.com/lost-rob0t/quasar-ui/issues/32) | Secure local files and recovery                | #10, #11, #30, #31                         |
| [#33](https://github.com/lost-rob0t/quasar-ui/issues/33) | CSP, import, renderer, and extension hardening | #11, #19, #22, #29, #30, #31               |
| [#34](https://github.com/lost-rob0t/quasar-ui/issues/34) | Accessibility, responsive, and touch support   | #12, #14, #15, #17, #23, #24, #25, #27     |
| [#35](https://github.com/lost-rob0t/quasar-ui/issues/35) | Performance workers, fixtures, and budgets     | #6, #13, #19, #23, #24, #25, #28, #29, #32 |
| [#36](https://github.com/lost-rob0t/quasar-ui/issues/36) | Production CI and static deployment            | #5, #31, #33, #34, #35                     |
| [#37](https://github.com/lost-rob0t/quasar-ui/issues/37) | Versioning, diagnostics, and operations        | #31, #32, #33, #35, #36                    |

Exit gate: the static PWA is reproducibly deployed, installable, offline-capable, secure under its CSP, accessible, performance-budgeted, recoverable, versioned, and rollback-ready.

## Production-readiness decision

A release candidate is production-ready only after all six phase gates pass and all of the following evidence is attached to the release:

- retained graph and storage fixtures pass every supported migration;
- offline reload, service-worker update, backup, restore, and rollback scenarios pass;
- clean static artifacts build without a backend runtime;
- the deployed artifact passes CSP, accessibility, performance-budget, direct-route, and repository-subpath checks;
- optional integrations fail closed while local graph creation and editing continue;
- diagnostics report the application, graph format, storage schema, dashboard manifest, and action contract versions;
- a known-good artifact and its documented rollback procedure are available.

Failure of any gate blocks promotion. Rollback restores a previously verified static artifact; it never attempts to reverse an incompatible local data migration without the recovery workflow owned by #32 and #37.

Release promotion uses one immutable artifact:

1. CI builds the static site from a clean, lockfile-enforced checkout and records its version and digest.
2. The unchanged artifact passes direct-route, repository-subpath, install, offline, update, recovery, CSP, accessibility, and performance checks.
3. An approved main-branch or tagged release promotes that exact artifact to GitHub Pages and retains it for alternate static hosting.
4. Post-deployment smoke checks record the deployed version, service-worker version, artifact digest, and result.
5. A failed smoke check restores the retained previous known-good artifact and publishes the failure in release diagnostics.

The production workflow, artifact retention period, Pages configuration, and operational commands belong to #36 and #37. This roadmap defines their gate and evidence requirements without duplicating those implementations.
