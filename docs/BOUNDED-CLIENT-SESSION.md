# Bounded client session: issue #114

Draft PR119 owns the client; draft PR120 combines it with #111 graph/dataset
catalogs and #112 document paging. This is not yet completion of #114: exact
review/degree statistics, real-stack acceptance, and the required Nix gates
remain open. No deployment or merge is authorized by this document.

## Startup and graph ownership

The production initializer selects bootstrap synchronization. Connection,
reconnection and workspace changes request `workspace.bootstrap`; snapshots
are disabled in this mode. The provider requests one compact `graph.catalog`
page (50 rows / 512 KiB) and opens an empty workbench. A saved graph ID never
auto-loads or activates a graph. More graphs replaces the catalog page; there is
no catalog drain or implicit migration. Unsupported/unmigrated servers fail
explicitly. The client factory retains legacy mode for compatibility callers.

Opening a graph is an explicit action. `graph.page` reconstructs descriptor,
membership, presentation collections and canonical node/edge sidecars; canonical
member bodies arrive in revision-bound ID batches of at most 50. The complete
requested graph must fit 2,000 members, 1,500 nodes, 3,000 edges, 8 MiB serialized
metadata/document data and the existing renderer limits. Each section has at
most 100 requests. Oversized, malformed, stale or cancelled reads fail before
activation or any graph replacement. Null/array/object container kinds and
unknown metadata are retained. UI normalization does not become the canonical
source: edits merge changed UI fields into the original complete metadata.
Selection is transient; refresh preserves it. Graph writes are serialized and
revision-checked. Opening a graph sends only `graph.activate`, not `graph.put`.

This bounds startup retained content independently of corpus size. Explicit
graph opening remains O(requested graph size), and complete graph metadata
replacement remains O(Mg), as documented by #111. It is not a delta-write claim.
The selected graph may be refreshed after changes; unrelated graphs stay compact.

## Canonical pages, cache and mutations

`client.reads` retains one search projection page (50 rows / 512 KiB) and a
canonical LRU capped at 250 records / 2 MiB serialized data. Projections never
enter the canonical cache. Only explicit missing IDs establish absence. Cache
serialization prevents editor mutations from corrupting canonical cache state.
Navigation, revision changes, reconnect and workspace changes cancel/invalidate
reads. One route pull is in flight at a time; cancellation discards late output
rather than preempting a backend request. Wire frames are parsed before response
budget validation; serialized byte limits are not exact JS heap limits.

Inspection and editors resolve canonical IDs independently of graph membership.
Reversible mutations/undo fetch only touched IDs (maximum 1,000, batches of 50),
preserve repeated-ID operation order and bind commit to the preflight revision.
Imports retain incoming IDs for create/update decisions while discarding prior
canonical bodies after each bounded lookup; staged commit retains its atomicity.
The #78 transaction overlay remains separately owned; no backend mutation files
are changed here.

The Documents route uses canonical `document.page` and the existing nested/source
substring predicate. A pull scans at most 1,000 records / 20 requests, has a
cooperative 250 ms deadline between requests, retains <=512 KiB of matches and
requests <=50 records at once. User row limits are <=250. Empty continuable pages
are supported. First/Next replaces offset navigation and invented exact totals.
Dataset pages use the authoritative `dataset.catalog` (50 rows / 512 KiB), including
Unix-second max updatedAt, scoped continuations and explicit migration errors.

## Explicit corpus operations

Exports traverse canonical continuations only on user action, await every sink
write/close, and abort on cancellation, scope/revision changes or sink failure.
Workspace export uses transactional Save File output with no Blob fallback.
Filtered/historical exports retain the full match predicate; a compatibility
browser fallback is capped at 2 MiB and never downloads partial output.
Search-to-graph retains at most 2,000 documents / 8 MiB and fails rather than
silently importing a visible page. Relation closure deletion retains <=1,000 IDs,
compares revisions across scans and again at commit, preserving undo. Worst-case
work is O(N * closure depth), with bounded retained IDs.

Builtin actor inputs use canonical selected/reference/generated IDs for reference
resolution and duplicate suppression outside the open graph. Legistar's declared
`documents.query` capability resolves its generated event/relation IDs. Actor
output validation, worker isolation, custom actor restrictions, abort signals,
ordered transforms and canonical commit preflight remain in place. Run-all's
linked/touched evidence streams the corpus but retains only IDs from its bounded
graph scope. Research input/dependency resolution is canonical and scoped;
reconnect invalidates the runner before late saves.

Agent queries and mutation preflight stream canonical records with bounded
retained matches; operations needing complete scope fail on overflow. Agent
prompt construction retains <=90 candidates before its existing 30-record prompt
limit while counting all matching records. These explicit actions may perform
O(N) visits; they are not indexed query-work claims. No startup scan is added.

CouchDB projection synchronization stages a consistent complete canonical export
on disk before reconciling local projection rows in batches of 51. Tombstone
revisions are preserved for resurrection. Live sync is stopped before rebuilding.
Local projection storage is O(N) on disk; JavaScript retains a bounded batch.
A failed/cancelled reconciliation can leave the local projection partially
updated, but replication is not restarted and canonical storage is unchanged.
Retry reconciliation before pushing. Pull imports use staged bounded chunks.

## Remaining blocker and evidence

`dataset.catalog` cannot supply StatsPage's reviewed/unreviewed totals, reviewed
dtype/dataset counts or top-connected reviewed nodes. The exact
`workspace.statistics` proposal is recorded on #111, comment 6227623043, for parent
assignment to the catalog owner. No agreed implementation/head has arrived.
The draft dashboard shows the authoritative bootstrap document count and an
explicit unavailable state for review metrics; it never treats a graph/cache as
the corpus. This is a known feature gap, not a completed statistics migration.

Unit tests cover actual provider startup with a 100,000-document bootstrap,
activation-only graph switching, metadata preservation on edits, graph budgets,
canonical actor dedup, bounded agent inputs, revision/cancellation, and staged
projection reconciliation. Browser startup/export/list/editor cases are authored
but not claimed executed locally. Existing real-stack graph/dashboard journeys
must be validated against the deliberate empty-workbench startup behavior.

Required commands use the repository Nix shell per AGENTS.md. Local setup is
blocked by proxy CONNECT 403 to cache.nixos.org/GNU sources after trusted CA setup;
Playwright Chromium download is also blocked. Hosted Nix previously failed at
the pinned private Forgejo dependency. No credentials/mirror/dependency changes
are made. Host frontend checks are supplemental, not substitutes for Nix,
Lisp/Tek9, real-browser or 10k/100k allocation/heap acceptance. Consult draft PR
comments for exact-head test counts and logs rather than assuming an earlier
passing run proves a later head.

Hosted evidence for the previous published heads: PR119 `d620086` passed the
Fresh Nix runtime/startup job 117262930004 (run 38987708636), but its browser
job failed three cases, including the dataset endpoint absent from that isolated
branch. Combined PR120 `d25067c` passed Lisp/stack smoke and 71 browser cases,
with canonical editor and mobile pan failures; its Nix job remained blocked by
the private dependency. These results do not certify the startup migration.
The new browser fixtures isolate canonical writes and persist mobile-pan graph
data; successful document commits also no longer fail merely because subsequent
metadata refresh failed. Hosted reruns must confirm these fixes. Browser gates
are retained; the catalog dependency is not hidden by skipping its test.
