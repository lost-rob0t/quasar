# ADR: Record-bounded ordinary workspace mutations

Status: accepted for Phase 3 of issue #24 / issue #37

## Context

Phase 1 made Tek9 the canonical durable workspace store. Phase 2 moved direct
document reads, paged snapshots, import staging, promotion, abort, expiry, and
restart recovery onto bounded Tek9-backed paths. Ordinary mutations still had a
contradictory runtime shape: `workspace-for` could restore the complete durable
workspace and `copy-workspace` could duplicate it before changing one record.
A one-document update therefore remained O(workspace corpus) in retained SBCL
objects even though persistence itself wrote only the changed record.

Phase 3 removes that heap requirement. Tek9 is canonical authority and the
control plane retains only records needed to validate and apply the current
operation or bounded transaction.

## Decision

Production Tek9 mutations use a record-level mutation context. The context holds:

- durable workspace metadata and base revision;
- a small persistent-workspace object used as an application-semantic overlay;
- lazily loaded documents, graph metadata, nodes, and edges;
- tombstone/presence state for staged reads and writes;
- the existing typed persistence changes emitted by validated workspace
  operations.

The authoritative path is:

```text
Tek9 canonical workspace
        |
        | direct key / bounded range / graph lookups
        v
record-level mutation overlay
        |
        | validated typed persistence changes
        v
one Tek9 write transaction
        |
        +-- canonical records/topology
        +-- workspace metadata + one revision advance
        +-- one journal entry
        v
committed event(s)
```

It is explicitly not:

```text
load complete workspace -> copy complete workspace -> mutate one record
```

The non-streaming `memory-store` keeps an explicitly named materialized
compatibility path for focused tests. It is not the production Tek9 mutation
architecture and cannot become durable authority.

## Lookup and validation semantics

Document existence, update, duplicate-ID, and graph document-reference checks
consult the overlay first and Tek9 second. A staged delete is a tombstone, so a
later operation in the same transaction cannot accidentally resurrect the
canonical record. A staged create/update is immediately visible to later child
operations.

Graph node/edge operations load only the relevant graph metadata plus referenced
nodes, edges, relation documents, and incident topology needed by that operation.
Document-delete and relation-dtype safety may require bounded primary-range scans
over graph sidecars because Tek9 does not currently expose a document-reference
index. Those scans retain only matching validation dependencies. They can be
O(graph sidecar count) in time but are not O(document corpus) in retained heap.

An explicit whole-graph replacement or graph deletion may load that one graph's
topology because the operation explicitly touches that graph as a unit. It does
not load unrelated graphs or the document corpus. Multi-graph transactions use
an exclusion-aware bounded metadata lookup so a graph deleted earlier in the
same transaction cannot be selected as the live replacement for a later delete.

All storage access uses exported Tek9 APIs. Quasar does not call `tek9::`, raw
LMDB APIs, private cursors, or copied LMDB implementation logic.

## Transaction semantics

`workspace.transaction` uses the same overlay as single operations. Child
operations execute in order and observe the overlay produced by earlier
children. This provides read-your-own-writes for create/update/delete and graph
references without exposing unrelated canonical records.

The transaction budget is 1000 child operations. Memory is permitted to grow
with the explicit touched/dependency set. It is not permitted to grow with the
unrelated workspace corpus.

A successful transaction has one transaction ID, one committed revision, one
journal record, stable child order, and ordered child events carrying
`eventIndex`/`eventCount`. A failed child discards the overlay and emits no event.

## Atomic durable commit

After validation, `commit-change-set` opens one Tek9 write transaction and:

1. re-reads the durable workspace revision and rejects a stale base revision;
2. applies typed document/graph/node/edge changes in operation order;
3. derives the resulting durable document count without enumerating the corpus;
4. writes workspace settings/metadata at exactly the committed revision;
5. writes exactly one journal entry;
6. commits Tek9.

Events are emitted only after that transaction returns successfully. Failure at
any staged boundary is therefore externally equivalent to no commit: no
canonical record/topology change, no revision advance, no journal entry, no
committed event, and no authoritative cache swap.

The full-workspace control-plane cache is not canonical for Tek9. Ordinary Tek9
mutations do not populate it, and a successful durable mutation removes any
legacy cached copy for that workspace. Restart correctness comes from Tek9.

## Memory contract and evidence

The Phase 3 contract is O(touched records + validation dependencies + bounded
range batch) retained working state for ordinary mutation and transaction paths.
The test suite observes the overlay's retained record count and compares the same
one-record update on 1,000 and 10,000 durable documents. The retained mutation
working set must remain equal and small while corpus size grows by 10x.

A mandatory 10,000-document real-Tek9 test closes/reopens the store, verifies no
workspace prehydration, performs ordinary mutations and a bounded transaction,
and asserts exact durable revision/journal/event behavior.

Failure-injection tests cover pre-change, post-change/pre-revision,
pre-revision, pre-journal, and pre-commit points. Restart tests reopen a new Tek9
store and control plane rather than trusting a surviving heap object.

## Structural regression boundary

`npm run check` runs a record-bounded mutation guard. It verifies that the
authoritative Tek9 routing functions do not call `workspace-for`,
`copy-workspace`, or `load-workspace`; bounded mutation modules do not depend on
those materialization helpers; and production Common Lisp does not use private
Tek9 or raw LMDB package APIs.

## Consequences

Tek9 remains the storage abstraction boundary and no Tek9 change or pin bump is
required for Phase 3. The application validation code still operates on familiar
workspace/graph objects, but those objects are partial overlays rather than a
second in-memory database. Explicit graph replacement has cost proportional to
the graph being replaced; ordinary document and focused graph mutations have
cost proportional to their touched/dependency set.
