# Bounded client session: issue #114 integration boundary

This is an independent, opt-in client foundation, **not completion of #114**.
The production provider still uses legacy snapshot hydration. Do not close #114
or advertise bounded production startup on the basis of this draft.

## Client contract

Create a client with `createControlPlaneClient(url, { synchronization: "bootstrap" })`.
Initial connection, reconnect, and workspace switching request only
`workspace.bootstrap`. `onBootstrap` receives metadata; `onSnapshot` is not
called with a misleading partial document array. A saved graph ID never triggers
graph restoration. Unsupported servers fail synchronization explicitly without a
snapshot fallback. `snapshot()` rejects in this mode. The default remains
`legacy-snapshot` until the provider's dependent consumers are migrated.

`client.reads` provides a single route's `search(filters)`, `next()`, and
`inspect(id)`. Search returns one `search-row.v1` page at a time (50 records,
512 KiB maximum accepted response). An empty page with a cursor is continuable.
Filters are copied, bounded to 8192 serialized UTF-8 bytes, and reused across
continuations. The client neither accumulates rows nor fetches another page
without an explicit `next()`. Callers must replace their visible page, not append.
Projections never enter the canonical document cache.

`inspect(id)` always resolves an uncached ID via revision-bound `document.batch`.
Only the server's explicit `missingIds` establishes absence. Canonical documents
are cached with LRU eviction at 250 records / 2 MiB serialized UTF-8 data. Cache
values are serialized so caller/editor mutations cannot alter cached content or
its byte accounting. Byte accounting bounds serialized data, not JS object heap
exactly; Map/string/parse overhead and the current response also consume memory.
The wire frame is parsed before this client validates its response budget; this
is not a transport-level defense against an unbounded/malicious server frame.

Navigation must call `reads.cancel()` and release its own page/selection references.
Workspace switch, socket close, disposal, resynchronization and delivered events
invalidate all cached canonical data and continuation state. Cancellation discards
late responses; it does not preempt a backend request. Only one route read may be
in flight, including a cancelled read until it settles/times out, so cancelled
requests cannot accumulate through this API. Transport commands outside this API
retain their existing semantics. After invalidation or `query.stale-cursor`, call
`client.resynchronize()` and restart the query rather than mixing revisions.
Read failures are propagated; there is no automatic continuation retry loop.

## Ownership and integration blockers

Changes are confined to the client/read session, their tests, and this document.
No edits to backend workspace/store files, #78's draft #115 mutation modules,
#110 actor submission work, or Android #120. Parent coordination is required
before shared-file integration. Ownership/interface proposal is recorded on #114.
No `.agents/skills` exists in this main checkout or the workspace `.agents` directory.
Root `AGENTS.md` and `docs/BOUNDED-WORKBENCH.md` govern this work.

- #111: agree compact graph/dataset catalogs and requested graph membership/topology
  paging before provider startup switches. Never restore unrelated graphs.
- #112: this module consumes the current opaque revision-bound search cursor.
  It assumes no offset or cursor encoding. Explicit exports still need a canonical
  streaming sink and agreed export/compatibility contract; this draft does not
  relabel the existing materialized exporter as streaming.
- #78: canonical ID lookup is available for mutation existence decisions, but the
  provider/adapters/undo/redo/import/actor consumers still need to adopt it instead
  of interpreting their current global arrays as complete. The mutation overlay
  remains a separate workstream.
- Migrate Documents/Datasets, selection and add-to-graph, editors, undo/redo,
  actor input, imports, exports and sync together with route cancellation. Only
  then switch the production `initializeControlPlane` path to bootstrap mode.

## Complexity and evidence limits

For this opt-in path, startup makes one metadata request. Route-retained canonical
content is O(min(selected records, 250)) and at most 2 MiB serialized bytes; search
retains a bounded filter/cursor and returns at most one bounded page. Retention is
independent of unrelated corpus size N. LRU lookup/refresh is expected O(1), plus
serialization proportional to the selected document; eviction can remove up to
250 entries. Server search work remains the existing bounded primary scan.

Production startup remains Θ(N) documents / Θ(B) canonical content. No measured
production heap, latency, transport-size improvement is claimed. Tests with
10k/100k _declared counts_ are synthetic contract tests, not real corpus benchmarks.
Real 10k/100k server/browser heap evidence, full feature journeys, actual Android
and device tests, Lisp/auth/atomicity integration, and required Nix checks remain
merge blockers. The work does not deploy or modify live data.
