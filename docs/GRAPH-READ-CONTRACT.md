# Graph reads: issue #111 handoff

Status: **proposed v1 contract; catalog and paging are not advertised capabilities**.
The direct compatibility `graph.snapshot` fix is implemented separately. It reads
only the requested persisted namespace and canonical sidecars, in one Tek9 read
transaction. It still materializes the entire requested graph. Do not use it as a
bounded startup primitive.

## Startup contract for #114

`workspace.bootstrap` remains unchanged. `savedGraphId` remembers the selection;
it must not trigger eager activation or a graph snapshot at startup.

Proposed `graph.catalog` request:

```json
{"limit":50,"byteLimit":524288,"scanLimit":1000,"deadlineMs":50}
```

Proposed response:

```json
{
  "revision":4,
  "projection":"graph-catalog.v1",
  "graphs":[{"id":"case-1","name":"Case 1","documentCount":3,"nodeCount":3,"edgeCount":1}],
  "savedGraphId":"case-1",
  "complete":false,
  "cursor":"opaque-token",
  "performance":{"scanned":1,"stopReason":"records"}
}
```

Rows must come from a separate compact durable catalog, never decoded legacy
metadata with `documentIds`, positions or groups. Counts represent persisted
membership/topology, not the number currently displayed. Names and IDs retain
exact values; an oversized row fails explicitly rather than truncating identity.
An initial empty workspace needs an explicit default-graph rule in integration,
consistent with `all-documents` and existing activation behavior.

Proposed `graph.page` request:

```json
{"graphId":"case-1","section":"nodes","expectedRevision":4,"limit":50,"byteLimit":524288,"scanLimit":1000,"deadlineMs":50}
```

Response fields: `revision`, `projection: "graph-page.v1"`, `graphId`, `section`,
`records`, `complete`, `cursor`, `performance`. Sections are `members`, `nodes`,
`edges`, `positions`, `groups`. Members return `{documentId}` rows; nodes and
edges return canonical sidecars unchanged, including cross-dataset relationship
references. Positions return `{nodeId, position}`; groups return canonical group
objects. Ordered sections require durable ordinals where legacy array order has
meaning. Small graph presentation fields (layout and viewport) need a separately
bounded descriptor; catalog must not embed unbounded presentation state.

Both interfaces default to 50 rows, allow at most 250 rows, 1,000 scanned records,
50 milliseconds between store calls, and 512 KiB including the result envelope.
Requests may lower budgets. Byte minimum follows `document.search` (32 KiB).
No single-row overflow exception: return `query.record-too-large`. Decode memory
is at least the largest existing stored record; writes/migration must enforce
compact record sizes before claiming a hard allocation bound.

Cursors are opaque versioned tokens bound to authenticated workspace, workspace
revision, projection, graph and section where applicable, and the last encoded
primary key. Continuation uses an exclusive seek, never an ordinal rescan. Page
size may change; graph/section/workspace may not. Stale revision returns
`query.stale-cursor`; a scope mismatch returns `query.invalid-cursor`. Validate
`expectedRevision` on the first page as well, so catalog and topology cannot mix
revisions. The token must fit existing cursor intake/output bounds.

`complete`, not row count, determines exhaustion. An empty page may have a
continuation. Clients request pages only for the visible catalog or selected
graph, cancel by ceasing requests, and keep bounded caches. No page aggregation
at startup and no graph payload on new document-only endpoints. The legacy
`workspace.snapshot.page` contract is still unchanged until #112/#114 coordinate
its consumers; this draft does not silently remove fields that they use.

## Persistence contract for #78 and #113

Catalog rows, counts, membership and presentation rows must change inside the
same existing Tek9 `:full` write transaction as canonical metadata, sidecars,
revision and journal. Integration should attach to `%apply-change` and shared
`%replace-graph`, `%put-node`, `%put-edge`, deletion helpers, including imports.
Do not add a second transaction or post-commit repair. Count deltas must distinguish
an insert from an overwrite and handle cascaded edge deletion exactly once.
Graph replacements/deletions and explicit workspace saves must remove stale
catalog/index rows. Activation remains workspace metadata, avoiding a catalog
rewrite for every graph when selection changes.

A versioned per-workspace readiness marker is required. Legacy stores must not
silently return an empty catalog or lazily decode all graph metadata on reads.
Before readiness, return a documented migration-required result/error (final
error registration pending integration). Run explicit migration off startup,
with bounded batches and a revision-bound durable checkpoint. Build shadow rows;
publish readiness only after atomic completion at the same canonical revision.
Concurrent writes must either update the shadow generation or invalidate its
checkpoint. Failure/restart must never advertise partial indexes. Existing
legacy graph snapshots remain available before migration. No storage schema
version bump or destructive rewrite is authorized by this proposal.

## Ownership and verification status

#111 owns graph persistence/read contracts; #78 owns transaction internals; #113
owns validation indexes; #112 owns document continuation; #114 owns client
consumption. Shared hooks, command registration, capability admission and ASDF
entries require parent coordination before edits. PR #110 and Android PR #120
are untouched. This proposal does not claim that those dependencies are complete.

Direct snapshot source complexity changes from all saved graph metadata and
all topology to one metadata lookup, two requested-namespace topology reads,
and one canonical lookup per requested node/edge: O(Mg + Vg + Eg) decode work
for requested graph g, independent of unrelated graphs. The redundant final
clone is removed because restoration already returns fresh decoded/cloned state.
This is a source-derived claim, not an allocation benchmark result.

The regression added to `phase2-protocol-tests.lisp` instruments exported Tek9
reads, forbids primary enumeration, checks exact requested namespace/key scope,
compares membership/presentation/sidecar fields, and expects 4 fetches plus 2
topology reads for the tiny fixture before/after adding 24 unrelated graphs and
a restart. Missing-graph and cross-workspace reads remain `graph.not-found`.
Run via `nix develop --command npm run test:lisp`; unexecuted tests must not be
reported as passing. Catalog byte/cursor/migration/failure-injection acceptance
remains pending implementation and integration.
