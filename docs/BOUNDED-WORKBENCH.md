# Bounded workbench migration

Status: **first dependency implemented; the complete workbench migration remains open**.

This change provides executable Tek9-backed read APIs and measured regression
gates. The existing React provider still drains snapshots at startup, and ordinary
mutations still use a full-workspace candidate. Those production paths are not
fixed by adding these endpoints. This change must not close the scalability mission.

## Verified authority and storage boundary

- StarIntel release and wire schema: `0.10.1`.
- Canonical repository: `lost-rob0t/star-lang`, commit
  `9198370f7a6f3e2a5ea00af3efdb6d705e102650`.
- Tek9: flake input `ca24ef35ea6877420cbca057dd7fb702fe29a740`.
- Canonical Quasar storage schema remains version 1; documents and durable data
  are not rewritten. New commands are an additive capability extension to
  `quasar.control.v1`. Search rows explicitly identify `search-row.v1` and are
  not canonical documents. Cursor format has an explicit version 1 marker.
- Reads use exported `fetch*`, `select-primary-range`, and read transactions.
  Fixture writes use exported Tek9 transactions and `put-bulk`. LMDB internals
  are never accessed. `:full` durability remains in effect.

Check the schema pin without writes:

```sh
python3 vendor/star-cl/bin/sync-starintel-schema.py \
  --lock vendor/star-cl/schema/starintel-schema.lock.json \
  --source /path/to/star-lang
```

## API contracts

All commands retain the existing envelope's authenticated workspace isolation and
WebSocket capability gate. Dataset names never select a different workspace.
An omitted dataset filter searches every dataset in that authorized workspace.
Omitted `metadata.workspace` selects `default`; a present value must be a
non-empty string. Admission and dispatch share the same envelope decoder, so
JSON `null`, booleans, numbers, arrays, and objects cannot select a workspace.

### `workspace.bootstrap`

Request: `{}`. Reads exactly one workspace metadata record and returns:

```json
{
  "id": "default",
  "revision": 4,
  "documentCount": 100000,
  "savedGraphId": "case-1",
  "limits": {
    "pageRecords": 250,
    "responseBytes": 524288,
    "scanRecords": 1000,
    "scanMilliseconds": 50
  }
}
```

No documents, graph memberships, topology, presentation maps, or settings objects
are returned. `savedGraphId` is a remembered selection, not an activation request.
Unknown legacy document counts remain `null`; a new empty workspace reports zero.
Capabilities are obtained separately through the existing session-filtered
`system.capabilities` command.

Dataset summaries and named-graph catalogs are a dependent change. Existing graph
metadata rows contain complete `documentIds` and presentation state; decoding
those rows just to extract names still allocates membership-sized objects. A
transactionally maintained compact catalog with an explicit legacy migration is
needed before placing graph catalogs in bootstrap.

### `document.search`

Example request:

```json
{
  "q": "example",
  "datasets": ["alpha", "beta"],
  "dtype": "person",
  "fields": {"countryCode": "US"},
  "updatedAfter": 1700000000,
  "limit": 50,
  "byteLimit": 524288,
  "scanLimit": 1000,
  "deadlineMs": 50
}
```

Every filter is optional. `predicate` filters typed relationships without
substituting generic edges. `updatedBefore` is also supported. Time bounds are
inclusive Unix timestamps on canonical `updatedAt`. `fields` matches exact
top-level scalar fields. `q` is a case-insensitive substring match on top-level
string fields; this first version is not nested-field or full-text search.
Unsupported options fail rather than pretending to apply a filter.
Exact integer and timestamp filters are bounded to 4,096 bits (Common Lisp
`integer-length`). The normalized filter scope must encode to at most 8,192
UTF-8 bytes, including JSON escaping and field names. Oversized values or scopes
fail with `query.invalid` before reading the store. Continuations are limited to
16,000 characters on both output and input; if a stored key or workspace identity
would exceed that output bound, the query fails with `query.invalid` rather than
returning a token that continuation intake would reject.

Response fields:

- `revision`, `projection: "search-row.v1"`, `documents` (compact rows).
- `complete`: exhaustion of the searched scope, not whether this page is full.
- `cursor`: opaque continuation or `null` when complete.
- `performance`: scan mode, decoded/scanned records, elapsed milliseconds,
  projected document bytes, and stop reason (`records`, `bytes`, `scan-budget`,
  `deadline`, or `complete`).

Rows retain document ID, dataset, dtype, schema version, relationship predicate and
directional endpoints. Display strings are limited to 256 characters. Fetch the
canonical record for inspection/provenance using an ID lookup or bounded batch;
do not submit a search projection as a canonical write.

Default page size is 50; maximum is 250. Query work stops after at most 1,000
scanned records or 50 ms between storage operations. Requests may lower budgets.
Responses, including the result envelope, are bounded by 512 KiB. An empty page
can have a continuation: no match within the current scan budget does not mean
no match in the corpus. A full last page may need one final empty exhaustion
page. Clients must not equate page length with completeness.

Ordering is existing encoded primary-key order, with unique document IDs. Because
the canonical key contains a length-prefixed ID, this is **not** raw lexical ID
ordering for unequal-length IDs. Continuations bind the workspace, revision,
normalized filter scope, and last scanned key. Page-size changes are permitted.
Each page uses one real Tek9 read transaction. Revision changes return
`query.stale-cursor`; workspace/filter changes return `query.invalid-cursor`.
Clients restart the query instead of combining revisions.

This fallback is explicitly reported as `bounded-primary-scan`; it is not an
index. It seeks from the last scanned key, never rescans a high ordinal offset,
and never materializes all matches. It retains a page plus at most two decoded
canonical records (Tek9's exclusive-seek lookahead). The largest stored record
is a lower bound on decode memory; an existing oversized record still needs a
Tek9 decode. Byte limits bound responses, not the size of previously stored
records. Secondary indexing and stored-record limits remain separate work.

Cancellation/backpressure for this stateless interface is pull-based: stop
requesting continuation pages. No background query or result collection survives
between requests. Deadlines are cooperative between Tek9 calls and cannot
preempt decoding a single stored record. This does not implement cancellation of
the existing Sento mailbox or long-running graph jobs.

### `document.batch`

```json
{"ids":["person:1","person:2"],"expectedRevision":4,"byteLimit":524288}
```

Returns canonical documents and explicit `missingIds` from one read transaction.
Duplicate IDs are idempotent; input is bounded to 250 IDs of at most 512
characters. `ids` is required; an empty array is valid. An oversized batch returns
`query.record-too-large` without silently returning a prefix. A deadline returns
`query.deadline`; request a smaller batch. `deadlineMs` may lower the 50 ms
maximum. Stale `expectedRevision` returns `query.stale-cursor`.

## Legacy migration and ordered dependencies

1. **This change:** bootstrap, bounded cross-dataset search, ID batches, call-path
   instrumentation, 10k/100k memory regression gates, and reproducible baselines.
2. **Depends on 1:** durable compact dataset/graph catalogs, bounded membership
   paging, removal of startup `snapshot()` draining, explicit empty workbench,
   route-specific query caches with byte/record eviction, backend-backed Documents
   and Datasets, direct lookup for editors/undo/actors/export/sync. Preserve all
   existing features while replacing their assumptions about global documents.
3. **Depends on 1 and catalog/membership storage:** bounded ordinary mutation
   overlays, transactionally maintained indexes/counts, atomic membership deltas,
   Search → Add to Graph, incremental saved graph loading, typed neighborhoods,
   and stable-ID Cytoscape diffs.
4. **Depends on 2–3:** opt-in Full Graph supervised bounded workers, durable
   progress/recovery, cancellation, partitions/aggregation/LOD, diagnostics, and
   browser startup/heap/responsiveness acceptance measurements.

These are dependencies, not additional finished PRs. Existing `workspace.snapshot`
and `document.list` keep their compatibility behavior in this first change.
Legacy consumers migrate metadata reads to bootstrap and display reads to a
single search page at a time. Exporters may explicitly traverse continuations
while streaming output to a sink; they must not concatenate the entire corpus.
Changing the main client's startup before migrating graph metadata, mutation
existence checks, undo, actors, and exports would silently break working features.

Existing Cytoscape protections remain authoritative: COSE switches above 250
nodes, with hard document/node/element cutoffs documented in
`frontend/docs/graph-scale-audit.md`. A capped visible page is not Full Graph.

## Evidence

See [bounded read performance](BOUNDED-READ-PERFORMANCE.md). The full Lisp suite
includes real Tek9 assertions for cross-dataset search, deterministic paging,
byte stops without omissions, stale/mismatched cursors, typed projections, ID
budgets, WebSocket workspace/capability denials, and a 10k/100k allocation gate.
Instrumentation rejects `workspace-for`, `load-workspace`, `copy-workspace`,
metadata graph restoration, graph enumeration, and unlimited primary scans on
the new read paths. The stack smoke test exercises all three commands through
a real WebSocket connection.
