# Graph reads: version 1

Implemented by issue #111 / draft #117. These additive commands use the existing
authenticated workspace envelope and per-session capability gate. #114 owns
client consumption; #112 owns document continuation/export. No legacy snapshot
shape or production startup switch is changed by this backend PR.

## Catalog

`graph.catalog` accepts `limit`, `byteLimit`, `scanLimit`, `deadlineMs`, `cursor`
and `expectedRevision`. All are optional. Example response:

```json
{
  "revision":4,
  "projection":"graph-catalog.v1",
  "graphs":[{"id":"case-1","name":"Case 1","membershipMode":"explicit","documentCount":3,"nodeCount":3,"edgeCount":1}],
  "savedGraphId":"case-1",
  "complete":false,
  "cursor":"opaque-token",
  "performance":{"mode":"bounded-graph-seek","scanned":1,"stopReason":"records"}
}
```

Rows come from `graph-catalog-v1/` records, never legacy graph metadata. Each
stored catalog/index row is limited to 8,192 encoded UTF-8 bytes. IDs (at most
512 characters) and names retain exact values. An oversized write/migration fails
with `graph.catalog-invalid`; it is never truncated. Counts represent persisted
topology and membership. `membershipMode: "all"` preserves null `documentIds`
semantics and reports the workspace document count, or null for unknown legacy
counts. `savedGraphId` is remembered selection, not an activation instruction.
A never-persisted workspace returns an empty catalog without writing state.

## Sections

`graph.page` requires `graphId` and `section`, plus the same optional budgets,
`cursor`, and `expectedRevision`. Bind its first page to the catalog revision.

```json
{"graphId":"case-1","section":"members","expectedRevision":4,"limit":50}
```

The response has `revision`, `projection: "graph-page.v1"`, `graphId`, `section`,
`records`, `complete`, `cursor`, and `performance`.

| Section | Records |
| --- | --- |
| members | `{documentId}`; explicit membership order retained |
| nodes | Unchanged canonical node sidecars |
| edges | Unchanged canonical edge sidecars, including typed/cross-dataset references |
| positions | `{key,value}` for each presentation map entry |
| groups | `{key,value}` for objects; `{index,value}` for arrays |
| selection | `{index,value}` for selected-ID arrays |
| descriptor | One `{metadata,collectionKinds}` row with remaining small metadata |

`collectionKinds` records `object`, `array`, or `null` for documentIds, positions,
groups and selectedIds so reconstruction preserves the original container type.
Array sections use zero-padded ordinal keys to preserve order; objects and
catalogs use encoded primary-key order. This is not raw lexical ID ordering.
For implicit all-document membership, members seeks canonical document records
and projects only IDs; it never collects the corpus. Nodes/edges use existing
canonical sidecar keys, avoiding topology enumeration entirely.

## Bounds and continuations

Defaults: 50 rows, 512 KiB, 1,000 scanned rows, 50 ms. Maxima: 250 rows, 512 KiB,
1,000 scanned rows, 50 ms. Byte minimum is 32 KiB. Unknown request fields and
unsupported sections fail. `expectedRevision` applies to catalog and section
requests, including the first page.

The final encoded result envelope is checked against `byteLimit`. Rows reserve
space for cursor/envelope overhead. A row that cannot fit fails with
`query.record-too-large`; no single-row overflow exception exists. Previously
stored large canonical sidecars/documents can still cost their decode size.
Only catalog/derived presentation rows have the new 8 KiB storage bound.

Each request uses one Tek9 read transaction and exclusive primary-key seeks,
retaining a page plus at most two decoded records (Tek9 lookahead). The reported
`scanned` counts logical rows; a seek may decode its previous-key lookahead too.
Deadlines are cooperative between storage calls, not preemptive of one decode.

Tokens bind version, authenticated workspace, workspace revision, projection,
and graph/section where applicable, plus the last scanned key. Page size may
change. Scope changes return `query.invalid-cursor`; revision changes return
`query.stale-cursor`. Existing 16,000-character cursor bounds apply. Final token
or envelope overflow returns an error rather than an oversized response.

`complete`, not row count, determines exhaustion. An empty page can carry a
continuation (for example, a deadline before the first record). Clients stop
requesting to cancel, keep bounded caches, and never silently fall back to eager
snapshots. New document-only reads remain `document.search`/`document.batch`;
#112 provides its additive export continuation. Legacy snapshot pages retain
compatibility, including graph payloads, until their consumers migrate.

## Durable updates and explicit migration

Canonical storage remains schema v1 with `:full` durability. Compact rows,
metadata, membership/presentation indexes, sidecars, counts and readiness share
the caller's existing write transaction. `%apply-change` and shared persistence
helpers cover graph replacement/deletion, node/edge upsert/delete, explicit
workspace saves, and first-import default graph creation. Count deltas check
canonical sidecar existence, making overwrites/repeated deletes idempotent.
Activation remains workspace metadata; it does not rewrite every catalog row.

The hooks do not change #78 transaction internals. Graph metadata replacement
currently rebuilds that graph's membership/presentation indexes, O(Mg), because
the existing mutation contract provides complete metadata. This PR does not
claim bounded graph metadata writes; a future #78 delta interface can replace
that cost. Node/edge count updates add only constant record lookups/writes and
do not scan topology. Preserve these helper calls when integrating #78/#113.

Existing workspaces without the version-1 readiness marker return
`graph.catalog-migration-required`. Do not auto-migrate during startup or reads.
An operator can invoke, inside the repository Nix runtime:

```lisp
(quasar.store:migrate-graph-catalog store "workspace-id" :expected-revision 42)
```

This is deliberately an explicit, synchronous maintenance operation: it holds
one write transaction for the workspace rebuild. It reads one legacy metadata
record at a time and scans sidecars in bounded batches to rebuild counts. Legacy
metadata decode and membership processing may be large. It is not a bounded
request endpoint or resumable migration; reserve a maintenance window. Revision
validation occurs under the transaction. Concurrent writers cannot publish a
partial generation; on failure/restart LMDB rolls back the rebuild and readiness
marker together. Retry the operation after fixing the cause. Canonical schema,
graph snapshots and existing compatibility readers remain unchanged. Empty old
workspaces receive default graph metadata; fresh persisted writes are indexed
without needing migration.

## Complexity and verification

Catalog and section requests perform O(page rows) record visits plus seeks,
independent of unrelated graph topology. Catalog size is O(number of graphs),
with compact records. Added persistent index space is O(membership + presentation)
per graph; node/edge sidecars are reused. An exact compatibility `graph.snapshot`
now restores only the requested namespace: O(Mg + Vg + Eg) decode work, plus
Tek9's requested-topology sorting. It remains a fully materialized requested graph.

`graph-catalog-tests.lisp` covers row/byte budgets including result envelopes,
ordered continuation, scope/revision conflicts, empty continuable deadlines,
compact catalog counts, restart, migration failure/retry, mutation rollback,
overwrite/delete count idempotency, authorization, and allocation/read isolation
with 32 unrelated graphs containing 1,000 members and 64 nodes each. The existing
Phase 2 test also instruments exact graph snapshot namespace/key scope before
and after unrelated graph growth and restart. Run all with:

```sh
nix develop --command npm run test:lisp
```

Only recorded results for the matching commit are test evidence. The first
snapshot-only commit passed hosted Lisp/stack checks. Local Nix shell setup was
blocked by dependency downloads; hosted Nix runtime build hit HTTP 502 fetching
the pinned starintel-biz input. Catalog implementation validation is tracked on
draft #117; no result for an earlier commit proves this implementation passes.
