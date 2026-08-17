# Architecture

## Decision

Quasar keeps React and Cytoscape as its presentation layer and uses Common Lisp
as the canonical application/control plane. Tek9 is the canonical local
embedded document and graph persistence engine. LMDB is the durable storage
engine underneath Tek9. CLOG owns production hosting and browser session
issuance; the typed WebSocket is the command/event transport.

This is Phase 1 of issue #24. The active Common Lisp workspace is still fully
materialized as a compatibility working cache, and import sessions still hold a
copied candidate workspace plus encoded chunks. Process durability is therefore
complete for normal committed workspace mutations, but bounded-memory workspace
operation and durable streaming imports are not.

## Ownership boundaries

Browser-local state includes routing, component state, form buffers, hover and
menus, responsive presentation, selection, pan/zoom and drag frames, layout
animation, and PWA caches. None of these high-frequency interactions are
canonical workspace data.

The control plane owns StarIntel documents, named graph definitions and
membership, committed positions/viewport/layout/groups, workspace revision,
transactions, the journal, authorization, capability checks, and audit. Tek9
stores the durable local representation of those committed records. PouchDB is
populated only as an explicit CouchDB synchronization staging adapter. CouchDB
and PouchDB are never fallback local mutation authorities.

## Local persistent schema

The Quasar Tek9 schema is explicitly versioned as schema `1`. A global schema
marker and each workspace metadata record carry a version. A newer or otherwise
unknown schema fails closed instead of being interpreted as the current layout.

Each workspace has a stable length-prefixed namespace so identical document,
graph, node, or edge IDs in different workspaces cannot collide. The logical
schema stores records independently:

- workspace metadata: workspace ID, revision, active graph, durable settings,
  and schema version;
- one Tek9 document record per StarIntel document, preserving `_id`, `dtype`,
  and all canonical fields;
- one metadata record per named graph, excluding topology arrays;
- one canonical sidecar record per graph node and edge, preserving Quasar fields
  that are not part of Tek9's generic topology object;
- graph topology in Tek9 graph/v2 under a stable workspace + graph namespace;
- one append-only journal record per committed revision/operation or
  transaction.

Tek9 graph/v2 remains the topology authority. Quasar does not know Tek9's
internal uint64 row IDs, physical graph DBI names, or adjacency keys. Canonical
node/edge sidecars are application records, not a second graph database: they
preserve fields such as document references and committed presentation metadata
while source/target/predicate topology, parallel edges, and adjacency live in
Tek9 graph/v2.

Normal mutations never serialize the complete workspace into one value and do
not rewrite the complete document corpus. A graph replacement rewrites that one
graph namespace by definition; ordinary document, node, edge, metadata, and
settings mutations write only their affected records plus workspace metadata
and one journal entry.

## Storage lifetime, path, and durability

The production application creates one Tek9 environment for the control-plane
lifetime and closes it during shutdown. Deployments and tests may inject an
existing store or choose a storage path.

The default path follows the XDG data hierarchy:

- `$XDG_DATA_HOME/quasar/tek9/` when `XDG_DATA_HOME` is set;
- `~/.local/share/quasar/tek9/` otherwise.

Production state is not written into the repository, browser profile, working
directory, or `/tmp`. Tests use isolated temporary directories.

Canonical Quasar data uses Tek9's full durability mode. `:nosync` is not used
for canonical state or benchmark cosmetics.

## Canonical graph contract

StarIntel documents, including `relation` documents, are the intelligence
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

## Command path and atomic persistence

Every `quasar.control.v1` command carries a correlated ID, payload, client, and
workspace. The WebSocket layer validates Origin, session, workspace,
capability, size, and rate limits. It then sends canonical operations to the
Sento actor; WebSocket callbacks never mutate a workspace.

The actor deep-clones the active compatibility workspace, applies and validates
one operation or the complete transaction on that candidate, assigns the next
revision, and derives a typed persistence plan from the already-canonical
application result. The persistence plan contains record-level document,
graph-metadata, node, edge, settings/meta, and deletion changes. The store does
not reimplement Quasar business rules or regenerate IDs.

`commit-workspace` opens one composable Tek9 write transaction. The affected
records, graph/v2 topology and adjacency, workspace metadata/revision, and
journal entry all participate in that one LMDB transaction. The store also
checks the durable base revision before committing so a stale candidate cannot
silently overwrite a newer durable workspace.

Only after Tek9 commits successfully does the control plane install the
candidate in memory, acknowledge it, and broadcast events. A validation or
storage failure therefore causes all of the following:

- no durable candidate records or adjacency;
- no durable revision advance;
- no journal append;
- no authoritative in-memory swap;
- no event broadcast.

The in-memory store remains available for focused unit tests and implements the
same control-plane commit boundary.

## Restart and recovery

On process restart Quasar opens a new Tek9 store at the configured path and
reconstructs the compatibility workspace from structured records:

1. workspace metadata/revision/settings;
2. individual StarIntel documents;
3. named-graph metadata;
4. topology enumerated through public Tek9 graph APIs;
5. canonical node/edge sidecars;
6. ordered journal entries.

Recovery does not reuse the old Lisp workspace or store object. A missing
workspace still creates the ordinary new-workspace defaults on first use.

Before this phase, the production `memory-store` had no process-durable local
state, so there is no durable memory-store data set to migrate. The Tek9 schema
is versioned from its first durable release so future migrations can be
explicit.

## Import limitation and issue #24

Large document imports still use the single-writer actor and validate chunks
against an isolated copied workspace. The candidate now accumulates the same
record-level persistence plan used by ordinary mutations, and final import
commit is durable and atomic through Tek9. However the candidate workspace and
encoded chunks are still heap-resident until commit.

Issue #24 therefore remains open. The next storage phase is to move document
reads/paginated snapshots and import staging directly onto Tek9 so large corpora
no longer require a fully materialized SBCL workspace or full copied import
candidate. That phase must add durable staging, backpressure, restart recovery,
abandoned-stage cleanup, and bounded-memory telemetry without changing this
on-disk canonical schema.

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
