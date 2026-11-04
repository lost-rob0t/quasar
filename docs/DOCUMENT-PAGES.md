# Revision-bound canonical document pages (#112)

`document.page` is an additive, capability-gated command in `quasar.control.v1`.
Discover it using the session-filtered `system.capabilities` response. It requires
Tek9; unsupported stores return `query.unsupported-store`. It never restores graph
metadata, settings, or a workspace. No storage format or durability change.

Request: `{ "limit": 250, "byteLimit": 524288, "cursor": "opaque token" }`.
Omit cursor on the first request. Limit is 1–250 (default 250); byteLimit is
32768–524288 (default 524288). Unsupported options, including offsets and filters,
fail with `query.invalid`. Request workspace is the authenticated envelope scope.

Response: `{ "revision": 4, "documents": [], "complete": false, "cursor": "..." }`.
Documents are complete canonical records, not search projections. Ordering is
encoded primary-key order, which differs from lexical ID order for unequal-length
IDs. The token binds version, workspace, revision, `document.page.v1` scope, and
last returned key. Budgets may change between requests. Malformed, missing-key,
wrong-workspace and search-scope tokens fail with `query.invalid-cursor`; revision
changes fail with `query.stale-cursor`. Tokens are not authorization grants.
Every page reads metadata and records in a single Tek9 read transaction. A mutation
after that transaction is detected by the next request. No snapshot survives
between requests; this contract detects change rather than providing historical
MVCC snapshots. Never concatenate pages from different revisions.

`complete` alone indicates exhaustion. A full final page has a continuation and
requires one empty terminal page. Only terminal pages return `cursor: null`; do
not send that null back as a new request. A record that cannot fit the selected
budget fails explicitly with `query.record-too-large`. No record is silently
skipped, and a byte-boundary candidate is retried on the next page. Both encoded
result and result envelope are checked. A 16 KiB reserve reduces available record
bytes; final checks remain authoritative for long/escaped tokens and request IDs.
The largest existing canonical record still bounds decode memory even when it
cannot fit a response. There is no deadline promise for decoding a single record.

## Compatibility and ownership

Legacy `workspace.snapshot` and `document.list` retain ordinal `documentOffset`,
`nextOffset`, and graph behavior. Their offset rescanning cost is unchanged; an
ordinal is never silently interpreted as a key. Clients must explicitly negotiate
`document.page` and use its cursor. #114 owns client/startup migration; #111 owns
graph catalogs. This branch does not change startup policy or frontend hydration.
Unsupported capability must be surfaced or use a knowingly legacy path; never
silently claim bounded traversal on an old server. #78 transaction overlays and
PR110/Android PR120 are independent.

## Explicit streaming export

`quasar.store:stream-document-pages` takes a store, workspace, and synchronous
one-document sink, plus optional `:limit`/`:byte-limit`. It returns count and
revision. The sink must finish before the next record/page is read. No corpus
array is constructed. A file exporter can encode each record to its output stream
inside the sink. Exceptions propagate; if a revision changes or the sink fails,
discard/abort the partially written export. Do not automatically restart into the
same sink. Browser consumers can apply the same pull/await-sink protocol using
`document.page`; wiring existing UI exports remains owned by #114.

## Cost and validation

Source-derived: complete traversal changes from Θ(NP) decoded visits on the legacy
P-page path to O(N + P) visits for this API, including exclusive-seek lookahead,
byte-boundary retries and cursor-key checks. Tek9 may decode two rows per range
call. Tree seek cost is additional (typically O(log N) per range operation); this
is a decode amplification claim, not a claim of linear wall time or disk reads.
Retained page memory is bounded by the response budget plus canonical lookahead
and serialization temporaries. No full-workspace copy or ordinal prefix walk.

`document-page-tests.lisp` adds contract and real 10k/100k traversal instrumentation,
including actual Tek9 range calls, returned decoded rows, monotonically advancing
seeks, ordered streamed IDs and total allocations. Existing bounded-read command
and WebSocket admission tests also cover `document.page`.

Validation at authoring time: `git diff --check` passed. The required command
`nix develop --command npm run test:lisp` could not start: `nix: command not found`.
Thus no Lisp, real Tek9, 10k/100k allocation, integration, browser or benchmark pass
is claimed. Runtime evidence is a merge blocker; the added tests must pass through
the repository Nix shell on the final PR head. No deployment was performed.
