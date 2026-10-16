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
- #112: this module consumes opaque revision-bound search cursors. The additive
  `client.exportDocuments(sink, signal)` consumes PR118's `document.page` contract
  (39fd4c48), explicitly negotiating the capability and awaiting each canonical
  document write. The sink must implement write/close/abort and discard partial
  output on failure. Navigation, reconnect, mutation events, cancellation, stale
  revisions, malformed pages and sink failures abort without restarting or falling
  back. The helper does not accumulate output. The Documents page now exposes an explicit Export workspace action through the
  production provider, using a transactional Save File writer, cancellation, and
  capability negotiation. Unsupported browsers receive an explicit message; no
  corpus/Blob fallback runs. Existing filtered results and historical archive
  exports retain their legacy behavior. File picker waits are bound to the
  connection/workspace scope; cancellation while close is pending cannot report
  success, but the browser may already have committed the file before detecting
  cancellation. Abort is attempted and the original error is preserved.
  Supplemental frontend fixture tests validate this integration contract; they
  do not execute PR118's unverified Lisp backend.
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

## Production consumer progress and concrete remaining contracts

Single-document provider save/delete now fetches only the canonical ID via
bootstrap plus revision-bound batch, and commits one transaction with that exact
revision. Undo captures the authoritative prior record; eviction cannot decide
create versus update. A concurrent writer rejects the mutation instead of
recording a stale inverse. Navigation during lookup cannot mutate the new scope.
The existing post-write refresh still hydrates snapshots; batch/import existence,
actor corpus input and sync remain materialized. This is not bounded production
startup yet.

The remaining #111/#78 integration needs are concrete:

- Authoritative dataset summaries: name, document count, available dtype set and
  maximum updatedAt, with a revision, pagination/budgets, and explicit legacy
  migration/unsupported behavior. Counts must not come from a visible page.
- Compact graph catalog plus requested graph membership, nodes, edges, positions,
  groups and settings/presentation. All sections must bind to one revision and
  expose explicit completion. savedGraphId must not activate/load a graph.
- A partial graph cannot safely be submitted to graph.workspace.put as a complete
  replacement. Agree atomic membership add/remove and presentation-delta mutation
  contracts (or a bounded, explicitly complete requested-graph edit boundary)
  before migrating add-to-graph, undo or graph settings persistence.
- Define explicit empty-workbench and all-documents graph behavior without
  creating an implicit full-corpus membership array. Preserve existing render
  cutoffs and make incomplete membership distinct from an empty graph.

Two synthetic Playwright journeys exercise the real production export button,
provider/client wire requests and deferred-close cancellation, with mocked
transport/file sinks. They do not verify native OS save dialogs or backend
paging. Local Chromium installation failed with HTTP 403 Domain forbidden from
cdn.playwright.dev; these journeys remain unrun locally.

## Canonical route and reversible-batch migration

Document inspection and the canonical editor now resolve IDs through bootstrap
and a revision-bound canonical batch instead of provider-array membership.
Only explicit missingIds produces a not-found view. Navigation/workspace changes
cancel late responses. Inspection coalesces event refreshes to one in-flight
lookup; an editor keeps its opened draft across reconnect, but clears the old
scope on workspace change. Canonical create/edit carries explicit intent, so a
cache miss cannot overwrite a duplicate ID or recreate a deleted edit target.

Reversible batch preflight and skip-existing decisions now look up distinct
touched IDs (at most the 1,000-ID transaction bound), 50 at a time at one revision.
Oversized/deadline batches split; a single oversized record fails explicitly.
The ordered transaction retains only touched canonical records for inverse
construction and commits at expectedRevision. This retention scales with the
explicit transaction's touched bytes, not unrelated corpus size. It is not the
2 MiB read cache. Existing undo-history retention and post-write snapshot refresh
are unchanged. Non-history import staging and actor full-corpus input still need
separate migration; they are not advertised as bounded here.

A separate integration checkout/branch combines PR117 f4ac9ca, PR118 39fd4c48 and
PR119 for hosted combined-stack checks. Conflicts are limited to retaining both
read command registrations and both ASDF component entries. No backend-owner
branch was rewritten. Combined results must be read from that integration head;
individual PR test results are not combined-stack evidence.
