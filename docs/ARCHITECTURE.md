# Architecture

## Decision

Quasar keeps React and Cytoscape as its presentation layer and uses Common Lisp
as the canonical durable-state control plane. CLOG owns production hosting and
browser session issuance; the typed WebSocket is the command/event transport.

## Ownership boundaries

Browser-local state includes routing, component state, form buffers, hover and
menus, responsive presentation, selection, pan/zoom and drag frames, layout
animation, and PWA caches. None of these high-frequency interactions are
canonical workspace data.

The control plane owns StarIntel documents, named graph definitions and
membership, committed positions/viewport/layout/groups, workspace revision,
transactions, the journal, authorization, capability checks, and audit.
PouchDB is a replaceable query projection and CouchDB staging adapter. It is
never a fallback mutation authority.

## Canonical graph contract

StarIntel documents—including `relation` documents—are the intelligence
records. A durable named graph is a view definition containing:

- stable `id` and `name`;
- `documentIds`, or `null` for the `all-documents` projection;
- committed `positions`, `viewport`, `layout`, and `groups`;
- optional node/edge view records with validated document and endpoint
  references.

Cytoscape derives its elements from those records. It does not own a parallel
intelligence database. Document deletion is rejected while graph nodes refer to
the document and deterministically removes named-graph membership. Node
deletion removes incident edges. Responses and events contain authoritative
objects required to reconcile a projection.

## Command path and persistence

Every `quasar.control.v1` command carries a correlated ID, payload, client, and
workspace. The WebSocket layer validates Origin, session, workspace,
capability, size, and rate limits. It then sends canonical operations to the
Sento actor; WebSocket callbacks never mutate a workspace.

The actor deep-clones the authoritative workspace, applies and validates the
operation or complete transaction on that candidate, assigns the next
revision, and calls the store's atomic `commit-workspace`. Only after state and
journal persistence succeeds does it install the candidate, acknowledge, and
broadcast. A persistence or validation failure changes no live object, appends
no journal record, and emits no event.

The memory store used by development and tests implements the same atomic
contract and returns deep clones on load. It survives control-plane recreation
when the same store instance is supplied. A process-durable store remains a
future implementation of this boundary; the in-memory limitation is explicit
and is not disguised as browser durability.

## Transaction and event semantics

A successful transaction increments the workspace revision once. Each child
event has a unique `operationId`, all children share `transactionId` and
revision, and `eventIndex`/`eventCount` define order. A failed transaction
returns `transaction.failed` with the underlying stable error in `details`.

The browser tracks revisions per workspace, accepts distinct same-revision
children, filters inactive workspaces, and bounds operation-ID deduplication.
Reconnect rejects pending requests immediately and obtains a fresh snapshot
before declaring the projection synchronized. Mutations are never blindly
replayed.

## Security

Production WebSockets require a CLOG-issued session token and an allowed
Origin. Sessions bind a principal, authorized workspaces, and per-command
capabilities. Events are delivered only to the matching workspace. StarLang
load is absent from the normal browser capability set. Audit records contain
structured action/principal/workspace/command/outcome fields, never request
payloads or credentials, and are bounded in memory.

Explicit insecure development mode is available only to local development and
Playwright. It accepts isolated test workspaces but production never enables
that bypass.

## StarLang

StarLang remains Common Lisp-only. The adapter discovers `STAR-LANG.API`
dynamically so Quasar can boot without the compiler/runtime. No JavaScript
StarLang implementation or arbitrary Lisp evaluation endpoint exists.
