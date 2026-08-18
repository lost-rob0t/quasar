# Architecture

## Decision

Quasar keeps React and Cytoscape as its presentation layer and uses Common Lisp
as the canonical application/control plane. Tek9 is the canonical local
embedded document and graph persistence engine. LMDB is the durable storage
engine underneath Tek9. CLOG owns production hosting and browser session
issuance; the typed WebSocket is the command/event transport.

Issue #24 is the durable bounded-memory storage migration. Phase 1 established
Tek9 as canonical persistence. Phase 2 (#35) moved direct reads, paged snapshots,
and document-import staging/promotion/abort onto bounded durable Tek9 paths.
Phase 3 (#37) moves ordinary document and graph mutations plus
`workspace.transaction` off the fully restored/copied workspace path. The full
Common Lisp workspace remains an explicit compatibility/materialization facility,
not production mutation authority.

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
  schema version, and document count;
- one Tek9 document record per StarIntel document, preserving `_id`, `dtype`,
  and all canonical fields;
- one metadata record per named graph, excluding topology arrays;
- one canonical sidecar record per graph node and edge, preserving Quasar fields
  that are not part of Tek9's generic topology object;
- graph topology in Tek9 graph/v2 under a stable workspace + graph namespace;
- one append-only journal record per committed revision/operation or
  transaction;
- durable import-stage metadata and ordered chunk records used by Phase 2.

Tek9 graph/v2 remains the topology authority. Quasar does not know Tek9's
internal uint64 row IDs, physical graph DBI names, cursor internals, adjacency
keys, or raw LMDB API. Canonical node/edge sidecars are application records, not
a second graph database: they preserve fields such as document references and
committed presentation metadata while source/target/predicate topology, parallel
edges, and adjacency live in Tek9 graph/v2.

Normal mutations never serialize the complete workspace into one value and do
not rewrite or retain the complete document corpus. A graph replacement may
materialize and replace that one explicitly touched graph namespace by
definition; ordinary document, node, edge, metadata, and settings mutations
retain and write only their affected records plus validation dependencies,
workspace metadata, and one journal entry.

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
the document and deterministically removes named-graph membership. A relation
document is also rejected for deletion while any live graph edge still refers
to it. Transactions may delete the edge first and then the relation document;
the later delete observes the staged edge tombstone. Node deletion removes
incident edges. Responses and events contain authoritative objects required to
reconcile a projection.

## Bounded reads and durable imports

Direct `document.get` uses a canonical Tek9 key. Paged workspace snapshots use
bounded primary-range reads tied to the durable workspace revision so page
continuation cannot silently cross revisions. These paths do not hydrate the
full workspace cache.

Document imports use durable Tek9 stage namespaces instead of copied heap
workspaces. Chunk order and replay identity, stage budgets, expiry, promotion,
abort, and restart recovery are durable. Promotion validates the base revision
and atomically moves staged documents into canonical records with metadata and
journal changes. Cleanup scans are bounded and abandoned stages remain
recoverable/abortable across process restart.

## Record-bounded ordinary mutation path

For a production Tek9 mutation the control plane starts with durable workspace
metadata and a base revision, then builds a record-level mutation context. The
context lazily loads only the documents, graph metadata, nodes, edges, incident
topology, and reference dependencies required by the operation. Its workspace
object is a partial semantic overlay, not a restored canonical corpus.

Reads consult staged writes and tombstones before durable state. This gives a
transaction read-your-own-writes: a document created by one child can be
referenced by the next child, and a deleted record is absent to later children.
Duplicate/conflict and referential-integrity checks therefore operate on durable
base state plus the ordered overlay.

Some referential-integrity invariants do not yet have a dedicated Tek9 index.
Those checks use bounded primary-range scans over graph sidecars and retain only
matching dependencies plus the bounded scan batch. They may be linear in graph
sidecar count in execution time, but they do not make retained memory
proportional to the unrelated document corpus.

Explicit whole-graph replacement or deletion may materialize that one graph's
topology because the operation explicitly touches the graph as a unit. Unrelated
graphs and documents remain unloaded. Multiple graph deletes track effective
base-plus-overlay graph count and exclude already tombstoned graphs when choosing
a replacement active graph.

The bounded transaction budget is 1000 child operations. A transaction is
allowed to consume memory proportional to its explicit touched/dependency set;
it is not allowed to consume memory proportional to unrelated workspace size.

The non-streaming `memory-store` retains an explicitly named materialized
compatibility mutation path for focused unit tests. Production Tek9 routing does
not call `workspace-for`, `load-workspace`, or `copy-workspace` for ordinary
mutations.

## Command path and atomic persistence

Every `quasar.control.v1` command carries a correlated ID, payload, client, and
workspace. The WebSocket layer validates Origin, session, workspace,
capability, size, and rate limits. It then sends canonical operations to the
Sento actor; WebSocket callbacks never mutate a workspace.

For Tek9-backed ordinary mutations, the actor applies and validates the operation
or ordered transaction against the bounded mutation context and derives typed
record-level persistence changes from the canonical application result. The
store does not reimplement Quasar business rules or regenerate IDs.

`commit-change-set` opens one composable Tek9 write transaction. It rechecks the
durable base revision, applies the typed document/graph/node/edge changes in
order, updates graph/v2 topology and adjacency, derives document count without
corpus enumeration, writes workspace metadata/settings at exactly one new
revision, and writes exactly one journal entry. Phase 2 import promotion uses its
own durable staged promotion transaction with the same atomic authority model.

Only after Tek9 commits successfully does the control plane acknowledge and
broadcast success events. A validation or storage failure therefore causes all
of the following:

- no durable candidate records or adjacency;
- no durable revision advance;
- no journal append;
- no authoritative cache swap;
- no event broadcast.

A successful Tek9 mutation invalidates any legacy full-workspace cache entry for
that workspace. The cache is not canonical authority. The in-memory store
remains available for focused unit tests and implements the corresponding
control-plane commit boundary with its materialized compatibility model.

## Restart and recovery

On process restart Quasar opens a new Tek9 store at the configured path.
Ordinary reads and mutations derive correctness directly from durable metadata,
individual documents, graph metadata/topology/sidecars, and the journal; they do
not need to prehydrate the corpus into `control-plane-workspaces`.

An explicit compatibility/full-materialization path can still reconstruct a
workspace from structured records when required:

1. workspace metadata/revision/settings;
2. individual StarIntel documents;
3. named-graph metadata;
4. topology enumerated through public Tek9 graph APIs;
5. canonical node/edge sidecars;
6. ordered journal entries.

Recovery never reuses the old Lisp workspace or store object. A missing
workspace still creates the ordinary new-workspace defaults on first use.

Before durable Tek9 storage, the production `memory-store` had no
process-durable local state, so there is no durable memory-store data set to
migrate. The Tek9 schema is versioned from its first durable release so future
migrations can be explicit.

## Bounded-memory verification and issue #24

Phase 3 tests seed and reopen real Tek9 corpora and require ordinary mutations to
leave the full-workspace cache empty. The retained overlay working-set metric is
compared for the same one-record mutation at 1,000 and 10,000 unrelated
documents; transaction tests repeat the measurement at multiple explicit touched
record counts. A real 10,000-document corpus exercises update/create/delete,
restart, transaction, exact durable records, revision, journal, and events.

Failure injection covers stages before record application, after record changes,
before revision/meta, before journal, and before commit. Each failure must leave
canonical records/topology, revision, journal, and events indistinguishable from
no commit. The repository structural guard rejects obvious regression to
full-workspace materialization and rejects private `tek9::` or raw `lmdb:` use in
the bounded mutation architecture.

Issue #24 closes only when all of its durable bounded-memory acceptance criteria
are met across canonical storage, reads, paging, imports, ordinary mutations,
budgets/backpressure/cleanup, documentation, and large-corpus/failure evidence.
Phase completion by itself is not sufficient reason to close the parent.

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
