# ADR: Tek9 as Quasar's local workspace store

Status: accepted for Phase 1 and Phase 2 of issue #24

## Context

Quasar's Common Lisp control plane owns canonical command validation,
single-writer mutation ordering, workspace revisioning, transactions, journal
construction, graph/document referential integrity, reconnect recovery, and
event ordering. Phase 1 moved committed documents, graph state, workspace
metadata/revision, and journal records into structured Tek9 records, but it left
three corpus-sized heap requirements in place:

- `workspace-for` restores the complete document corpus into SBCL;
- import begin copies that complete workspace and import sessions retain every
  encoded chunk;
- paged snapshots enumerate the complete in-memory document hash before
  returning a page.

Issue #35 is the Phase 2 slice of #24. It removes those read/import heap
requirements without changing the Phase 1 canonical schema.

## Decision

Tek9 remains Quasar's canonical local embedded persistence engine. LMDB is used
only through exported Tek9 APIs. Quasar does not introduce a parallel database
abstraction and does not make CouchDB, PouchDB, or Cytoscape a local mutation
authority.

The dependency direction is:

```text
React / Cytoscape
        |
quasar.control.v1
        |
Quasar Common Lisp control plane
        |
Sento single-writer actor
        |
workspace-store + typed persistence plan + durable import stages
        |
Tek9 public APIs
        |
LMDB
```

Tek9 already provides ordered primary-key range scans with a bounded `limit`
and composable read/write transactions. Phase 2 uses those primitives rather
than adding a Quasar-specific Tek9 API. Repeated bounded scans may execute
inside one Tek9 transaction so promotion and cleanup do not require a
corpus-sized intermediate Lisp list.

## Canonical schema version 1

Phase 2 does not rewrite Phase 1 canonical keys. The schema has a global version
marker plus a per-workspace version marker. Unknown versions fail closed.

Stable length-prefixed workspace namespaces own:

- one workspace metadata record;
- one Tek9 record per StarIntel document;
- one named-graph metadata record per graph;
- one canonical node sidecar per node;
- one canonical edge sidecar per edge;
- one ordered journal record per commit.

Graph topology itself remains in Tek9 graph/v2 under the Phase 1 logical graph
namespace. Internal Tek9 row IDs, DBI names, cursor objects, and adjacency
encoding remain private.

## Direct read boundary

Document lookup and document paging read canonical records directly from Tek9.
They do not call `load-workspace` and do not populate the control plane's
full-workspace cache merely to satisfy a read.

Canonical document ordering is encoded Tek9 primary-key ordering. Pagination
uses bounded primary-range scans. Compatibility fields `documentOffset` and
`documentByteLimit` remain accepted, but Phase 2 also permits a revision-bound
opaque continuation token. A continuation is valid only for the workspace and
revision that produced it. A revision change makes the continuation stale and
returns a stable protocol error rather than silently mixing two revisions.

Legacy ordinal-offset requests remain supported as bounded scans for existing
clients. They may cost O(offset) cursor movement but must never allocate
O(total-corpus) Lisp objects.

Snapshot metadata comes from the durable workspace metadata record. Graph
metadata may still be restored independently where the existing protocol needs
it; document paging must not depend on restoring all documents.

## Durable staging keyspace

Import staging is stored in a separate Quasar-owned Tek9 primary-key namespace:

```text
quasar/v1/stage/<workspace-part>/<stage-part>/meta
quasar/v1/stage/<workspace-part>/<stage-part>/doc/<document-part>
quasar/v1/stage/<workspace-part>/<stage-part>/chunk/<sequence>
```

The length-prefixed workspace and stage components use the same collision-safe
encoding discipline as canonical workspace keys. Prefix scans must not cross a
workspace or stage boundary.

A stage metadata record contains at least:

- storage schema version;
- stage/session ID;
- workspace ID;
- base revision;
- creation time;
- last activity time;
- lifecycle state;
- accepted-through sequence;
- document operation count;
- byte count;
- validation state.

Lifecycle states are explicit strings: `OPEN`, `COMMITTING`, `COMMITTED`,
`ABORTED`, `FAILED`, and `EXPIRED`. Runtime storage state deliberately does not
reuse Org TODO keywords.

## Chunk sequencing and idempotency

Clients send a stable `sessionId`, a non-negative integer `sequence`, and an
operations array. Import operations remain limited to document create/update.
Validation occurs before a chunk becomes accepted.

The chunk record stores the sequence plus a deterministic digest of the encoded
operations. The contract is:

- sequence `accepted-through + 1` is the only new sequence accepted;
- replay of an already accepted sequence with the same digest is an idempotent
  success and does not change counters or staged documents;
- replay of an accepted sequence with different content fails with
  `import.chunk-conflict`;
- a sequence beyond the next expected value fails with `import.sequence-gap`;
- negative, non-integer, or otherwise malformed sequences fail with
  `import.invalid-sequence`.

A chunk write, its staged document overlay, counters, digest record, and stage
metadata update occur in one Tek9 transaction. A failed chunk leaves the stage
`OPEN` and changes none of those durable values. This permits a corrected retry
without reconstructing the stage.

## Incremental validation

Each staged document is the stage's current canonical overlay for that document
ID. Create/update validation checks the staged overlay first, then the canonical
Tek9 record. The entire workspace is never copied to validate a chunk.

Document shape and dtype rules remain the same as ordinary Quasar document
operations. Updates that would invalidate relation-document references must
still fail; direct storage reads may inspect graph sidecars/topology as needed,
but may not bypass referential-integrity rules.

## Backpressure and budgets

Phase 2 imposes explicit deterministic limits at the control-plane/store
boundary. Defaults are configurable constants rather than corpus-sized queues:

- maximum encoded chunk bytes;
- maximum operations per chunk;
- maximum active stages per workspace;
- maximum stage age;
- bounded primary-range batch size used by reads, promotion, and cleanup.

Budget violations return stable `import.*` errors before durable acceptance.
No accepted import payload is retained in a process-local growing vector.

## Atomic promotion

A stage begun at revision N may commit only while durable canonical workspace
revision is still N.

Promotion is one Tek9 write transaction. Inside it Quasar:

1. re-reads and verifies the stage metadata and base revision;
2. transitions the durable stage from `OPEN` to `COMMITTING`;
3. copies staged document overlays to canonical document keys using repeated
   bounded primary-range scans;
4. writes workspace metadata at revision N+1;
5. writes exactly one compact authoritative `document.import` journal record;
6. marks the stage `COMMITTED` and removes staged document/chunk rows with
   bounded deletion batches before the transaction commits.

Any condition or injected failure aborts the whole Tek9 transaction. After
reopen, durable canonical state is therefore exactly the old revision or the
fully promoted new revision, never an intermediate corpus.

The journal contains stage identity, base/committed revisions, document count,
byte count, timestamp, and client metadata. It never embeds every encoded chunk
or imported document.

Only after the durable transaction returns successfully may Quasar emit exactly
one `documents.imported` event.

## Revision conflicts

Commit compares the stage's durable base revision with the durable current
workspace revision inside the promotion transaction. A mismatch returns
`workspace.revision-conflict`. No staged document becomes canonical and no
import journal/event is produced.

Conflicted stages transition to a terminal state or are removed according to
the store policy, but they are never resurrected as an open stage after restart.

## Abort, expiry, and recovery

Abort is idempotent. It validates workspace/stage identity, marks the stage
terminal, and deletes only that stage's namespace using bounded scans. Aborting
one workspace can never remove another workspace's staged rows.

Stage expiry uses an injectable clock at the Quasar boundary. Cleanup compares
`lastActivity` with the configured TTL; tests advance the clock and never sleep
for wall-clock minutes. Cleanup after restart uses only durable Tek9 metadata.

A process restart creates a new Tek9 store object and a new control-plane object.
No process-local import-session object is required to inspect, resume, commit,
abort, or expire an existing stage.

## Reader consistency

Direct document pages read the durable workspace revision before the page. A
revision-bound continuation carries that revision. If the revision changes
before the next page, Quasar rejects the continuation as stale. The client must
restart paging from the first page. This gives deterministic no-duplicate/no-gap
semantics for a logical snapshot without retaining an SBCL corpus snapshot.

Legacy offset paging remains a compatibility path and is documented as
best-effort across concurrent revisions; it is still bounded-memory.

## Atomic normal mutation boundary

Phase 1 normal mutations still apply to an isolated in-memory candidate and
persist only typed record-level changes in one Tek9 transaction. Phase 2 does
not weaken that atomicity or event ordering.

Issue #24 is broader than #35. Before #24 can close, normal mutation paths must
be measured on a large workspace. If `copy-workspace` still duplicates the
complete document corpus for ordinary mutations, #24 remains open and a final
bounded-mutation phase is required.

## Performance and memory constraints

The required asymptotic properties are:

- fetching one document performs a direct key lookup rather than loading the
  workspace;
- a page of K documents allocates O(K + byte-limit) values plus seek/cursor
  overhead, not O(total-corpus);
- accepting a chunk writes only that chunk's validated overlay and metadata;
- retrying an accepted chunk does not rewrite earlier chunks;
- promotion is O(staged documents) with bounded retained batches, not O(N²);
- stage cleanup scans only that stage prefix;
- ordinary Phase 1 record persistence remains proportional to changed records.

Canonical state keeps Tek9 `:full` durability. Performance gates must not be won
by selecting `:nosync`.

## Failure injection

The store exposes test-only failure hooks at durable boundaries including chunk
acceptance and promotion. Tests reopen Tek9 after each injected failure and
assert exact durable state. Failure injection must cover at least pre-chunk,
post-staged-write/pre-metadata, pre-promotion, pre-revision, pre-journal, and
pre-finalization boundaries where the implementation can distinguish them.

## Migration and compatibility

Existing Phase 1 canonical data is schema version 1 and opens unchanged. Staging
adds namespaced records without changing canonical document, graph, metadata,
or journal encodings. Missing/corrupt stage metadata fails closed; a partial
staging namespace is never interpreted as canonical state.

Future newer schema versions must continue to fail safely until an explicit
migration path exists. Quasar must never silently wipe unknown data.

## Phase boundary

Issue #35 is complete only when direct document reads/paging and durable import
staging are proven by restart, replay, failure-injection, large-corpus, and
bounded-memory tests.

Closing #35 does not automatically close #24. If ordinary non-import mutation
still performs a corpus-sized `copy-workspace`, a follow-up bounded-mutation
phase remains mandatory.