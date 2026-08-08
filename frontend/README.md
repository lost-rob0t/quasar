# Quasar React UI

This directory contains Quasar's React, Vite, and Cytoscape presentation layer.
It is a workspace of the root monorepo and is not independently authoritative
for durable documents or graph state. The root [README](../README.md),
[architecture](../docs/ARCHITECTURE.md), and
[migration ledger](../docs/UI-MIGRATION.md) define the current product
contract.

## Data boundary

Common Lisp owns canonical StarIntel documents, graph definitions/membership,
committed graph presentation state, revisions, transactions, and journal
records. `QuasarProvider` initializes from `workspace.snapshot`, routes document
and graph commits over the typed WebSocket client, and refreshes from
authoritative events and snapshots.

PouchDB remains a replaceable local projection for existing map/reduce queries
and CouchDB staging. It is replaced from the Lisp snapshot and is never a
fallback for migrated mutations. Selection, editing buffers, menus, responsive
state, and live Cytoscape animation remain browser-local.

Settings and several browser network/actor adapters are transitional. Settings
transfer filters credentials; document and graph envelopes and audit logs never
contain those secrets.

## Development and validation

Use the root commands from a clean checkout:

```sh
nix develop
npm ci
npm run dev
npm run check
npm run test
npm run test:e2e
npm run smoke:production
```

Do not run `npx` to download tools. The root lockfile and npm workspace install
Vite, Vitest, Playwright, and all frontend dependencies. Playwright starts the
real Lisp/CLOG/WebSocket/Vite stack and assigns an isolated authorized
workspace to every test.

## Routes and visible capabilities

The application retains `/`, `/graph`, `/documents`, `/documents/new`,
`/documents/:id`, `/import`, `/settings`, and `/agents`, including desktop and
mobile graph shells, context menus, multiple graph workspaces, document/import
flows, actors/research UI, themes, settings transfer, and PWA installation.

Production uses root hosting (`/`). Vite assets, React Router, CLOG SPA
fallbacks, the manifest, and service-worker scope share that contract.

## Package boundaries

The typed package entrypoints remain:

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

`src/control-plane` owns transport correlation, per-workspace events, bounded
deduplication, connection state, reconnect/snapshot recovery, and command
adapters. `src/storage` exposes projection/query services, not authoritative
document or graph mutation APIs.
