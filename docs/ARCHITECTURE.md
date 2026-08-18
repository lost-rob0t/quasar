# Architecture

## Decision

Quasar keeps React/Cytoscape as its presentation layer and Common Lisp as the
canonical application/control plane. Tek9 is the canonical local embedded
document and graph store, with LMDB beneath Tek9. CLOG owns production hosting
and browser session issuance; the typed WebSocket is the command/event
transport.

Issues #24, #35, and #37 moved the storage runtime from a fully materialized Lisp
workspace model to durable, bounded Tek9-backed reads, imports, and ordinary
mutations. The complete workspace object remains only as an explicit
compatibility/bootstrap facility. It is not production mutation authority.

## Ownership boundaries

Browser-local state includes routing, form buffers, hover/menus, responsive
presentation, selection, pan/zoom/drag frames, layout animation, and PWA caches.
None of those high-frequency values are canonical workspace state.

The control plane owns StarIntel documents, named graph definitions/membership,
committed positions/viewport/layout/groups, workspace revision, transactions,
journal/event ordering, authorization, and capability checks. Tek9 stores the
durable representation. PouchDB/CouchDB are explicit synchronization adapters,
not fallback local mutation authorities.

## Durable schema

Schema version 1 stores each workspace in a stable collision-safe namespace:

- workspace metadata with revision, active graph, settings, schema version, and
  document count;
- one Tek9 record per StarIntel document;
- one metadata record per named graph;
- one canonical sidecar record per graph node/edge;
- graph topology/adjacency in Tek9 graph/v2 under workspace + graph namespace;
- one ordered journal record per committed mutation or transaction.

Quasar never depends on Tek9 private row IDs, DBI names, cursor internals, or raw
LMDB APIs.

## Bounded read and import paths

Direct document get and paged snapshots use direct keys and bounded primary-range
scans. They do not call `load-workspace` or populate the full-workspace cache.
Continuation paging is revision-bound so a revision change cannot silently mix
logical snapshots.

Document imports use durable Tek9 stage namespaces with ordered chunk digests,
explicit budgets, restart-safe lifecycle state, idempotent replay, bounded
promotion/cleanup scans, and one atomic promotion transaction. Process-local
encoded chunk vectors are not canonical import state.

## Record-bounded ordinary mutation path

For a Tek9-backed single mutation or transaction, the control plane creates a
record-level mutation context from durable workspace metadata. Documents, graph
metadata, nodes, edges, incident topology, and reference dependencies are loaded
lazily as the operation requires them. Staged writes/tombstones are checked
before Tek9, giving transactions read-your-own-writes without restoring the
unrelated corpus.

The existing workspace validators and typed persistence-plan compiler are reused
against the partial overlay. The authoritative routing functions never call
`workspace-for`, `load-workspace`, or `copy-workspace` for a streaming/Tek9
mutation. The in-memory store retains an explicitly named materialized fallback
for focused compatibility tests.

Document-reference safety may use bounded graph-sidecar scans where no dedicated
index exists. That can be linear in graph-sidecar count in execution time, but
retained heap is proportional to matching validation dependencies plus a bounded
scan batch, not the document corpus.

Explicit `graph.put`/graph deletion may materialize one explicitly touched graph
because replacement/deletion semantics operate on that graph as a unit. Unrelated
graphs and documents remain unloaded.

## Transaction semantics

Transactions apply child operations in order to one overlay. A child can see a
document/node/edge created or updated by an earlier child, and a tombstone hides
a record deleted earlier in the same transaction. Duplicate/conflict and graph
reference checks therefore evaluate base durable state plus staged writes.

The transaction budget is 1000 child operations. Retained memory may scale with
that explicit mutation/dependency set. It must not scale with unrelated workspace
size.

Multiple graph deletes track effective durable-plus-overlay graph count and use
an exclusion-aware bounded metadata lookup, so a graph tombstoned earlier in the
transaction cannot become the active replacement for a later delete. Deleting
the final effective graph fails and rolls the whole transaction back.

## Atomic persistence and events

After application validation, `commit-change-set` opens one Tek9 write
transaction. It rechecks the durable base revision, applies typed changes in
order, derives the new document count without corpus enumeration, writes
settings/workspace metadata at one new revision, and writes one journal record.
Graph topology and sidecars participate in the same Tek9 transaction.

Only after Tek9 commits does the control plane emit success events. Injected or
real storage failure therefore leaves no canonical record/topology changes, no
revision advance, no journal entry, no successful event, and no authoritative
heap swap. A stale base revision is rejected by the durable commit boundary.

A successful transaction advances revision exactly once and emits ordered child
events sharing transaction ID/revision with unique child operation IDs plus
`eventIndex`/`eventCount`.

## Cache and restart behavior

`control-plane-workspaces` is not canonical for Tek9. Ordinary Tek9 mutations do
not populate it, and a successful commit invalidates any legacy cached copy.
Restart creates a new store/control plane and derives correctness from Tek9
metadata, canonical records, topology, sidecars, and journal state.

Full `load-workspace` remains available for explicit compatibility/migration
work, but production mutation correctness cannot depend on it.

## Memory verification

The mandatory Phase 3 tests seed/reopen real Tek9 corpora and verify that a
one-record operation retains the same small mutation working set at 1,000 and
10,000 unrelated documents. Transactions are separately measured at multiple N
values and must grow with touched records, not corpus size. A 10,000-document
suite verifies exact records, revision, journal/event behavior, and zero
prehydrated workspace cache.

Failure injection covers multiple points inside the durable mutation boundary,
and restart tests reopen the real Tek9 environment after both success and
failure. `npm run check` also contains structural guards against reintroducing
full-workspace materialization or private Tek9/raw LMDB access into the bounded
mutation modules.

## Security and external services

Production WebSockets require a CLOG-issued session token and allowed Origin.
Sessions bind principals, authorized workspaces, and per-command capabilities.
Events are scoped to the matching workspace. StarLang load remains absent from
the normal browser capability set. Explicit insecure mode is restricted to local
development and Playwright.

External actor/research services remain capability-discovered StarIntel
integrations. Missing services reduce capability instead of silently moving
canonical logic into the browser.
