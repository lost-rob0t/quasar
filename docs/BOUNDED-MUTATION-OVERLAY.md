# Issue 78: transaction overlay port (draft)

The Tek9 mutation router uses an isolated partial `persistent-workspace` and
per-record presence/tombstone maps. It loads touched documents and graph
dependencies through exported Tek9 APIs, invokes the existing workspace
validators, and commits the resulting typed changes in one write transaction.
It never copies the cached document corpus or journal. Successful commits evict
the legacy materialized cache; failures discard the candidate and publish no
events. The in-memory compatibility backend retains deep-copy isolation.

This port reuses the mutation modules from draft PR #38 at
`65b91fccec2ce57f86de075d8a688242c8c44284`, reconciled against current main:
canonical 0.10.1 document IDs/fixtures, the current principal quota policy,
current command dispatch/authorization, and current ASDF components remain.
The old PR's control-plane split and documentation replacements were not copied.
Three unbalanced forms in its tests were repaired during supplemental SBCL
reader validation; its historical test claims are not evidence for this port.

A transaction accepts at most 1000 operations. One revision and one journal
entry commit atomically with the records. Child events are emitted afterward in
operation order, carrying a shared revision and transaction ID. Revision is
checked again inside the Tek9 write transaction. Whole-graph replace/delete
still explicitly materializes the affected graph. Document reference checks
may scan graph sidecars; retained state includes actual matching dependencies.

## Quotas

The trusted principal quota uses the same UTF-8 encoded workspace-snapshot
byte definition as the materialized path. It must never authorize an overlay's
partial byte size as though that were the complete workspace. A versioned,
revision-bound Tek9 accounting record stores sums of document and graph sizes
(including array separators). The commit updates document sums from old/new
records. Per-graph node/edge sums update from the typed sidecar changes, so
quota checks do not rescan topology for node/edge edits. Explicit graph
replacement computes counters from its submitted topology.
Settings, workspace ID and revision overhead are included exactly. The quota
callback runs inside the write transaction before metadata/journal commit;
rejection rolls back records and accounting together. Explicit save-workspace
replacement initializes accounting within its existing write transaction.

## Remaining acceptance gaps

This is not completion of #78 and is not merge-ready without runtime checks.

- Legacy accounting now migrates once at store initialization, in bounded
  batches inside one write transaction. This migration necessarily visits the
  old corpus, does not advance revision or journal, and publishes its version
  marker only on success. Subsequent cold opens read the marker only. Stale
  accounting fails closed during mutations; it never triggers a hidden scan.
  Explicit repair is `migrate-quota-accounting` with `:force t` while the store
  has exclusive ownership. Concurrent/downgraded legacy writers are unsupported.
- Staged import promotion computes old/new byte deltas only for staged IDs and
  commits counters and the quota policy check atomically with canonical data.
  Retry/replay does not charge twice. Post-import edits do not rebuild counters.
- Per-graph accounting removes topology recounts. Compact metadata/catalog
  integration still belongs to #111; large graph metadata remains affected data.
- Reference sidecar scans and full affected-graph replacement remain; #113
  owns workspace validation indexes. This port does not edit workspace.lisp
  or store.lisp and retains their dispatch/persistence helper interfaces.
- New tests cover quota rollback and exact byte accounting; ported tests cover
  ordered overlays, tombstones, conflicts, failure injection, restart and
  working-set counts. Working-set counts are not heap/allocation measurements.
- Execute all Lisp tests and the requested 10k/100k, 1 GiB heap crash regression
  on the exact published head through `nix develop` before review/merge. No
  measurement from the earlier unexecuted harness is claimed here.

## Reproduction

```
nix develop --command node scripts/check-mutation-overlay.mjs
nix develop --command npm run test:lisp
```

During this implementation the host had no Nix. A disposable `nixos/nix`
container reached flake evaluation after installing the host CA trust bundle,
but `cache.nixos.org/nix-cache-info` and the bash 5.3 source fetch from
`ftpmirror.gnu.org` failed with proxy CONNECT HTTP 403. Therefore the required
runtime suite and benchmarks were not executed. Supplemental SBCL reader and
host Node structural checks establish only syntax/routing properties, not
transaction correctness, performance, or a passing merge gate.

## Follow-up correctness checks

Hosted CI for initial head 254c0b2 executed Lisp and exposed a stale test cache
premise. Follow-up 0532884 reads durable revision/state and retains restart
assertions; its hosted suite passed that point and exposed actor-thread observer
fixture isolation. Event collectors now capture their test box and metrics
hooks install/restore their global value for the serialized test.

Regression tests also cover duplicate edge IDs during node restore (complete
rollback including quota/journal/events), populated durable revision-zero
graphs, and implicit graph create/delete state transitions. PR116 at 68645a7 is now merged into this branch with parent approval.
Single operations and transaction loops bind a fresh transient index context;
node/edge hydration uses the indexed append helper, preserving deep-copy
isolation and updating both ID membership and tail pointers. Promotion creates
new arrays, and destructive dispatch retains PR116's invalidation behavior.
Cold durable endpoint, staged append, durable/staged collision, and rollback
coverage asserts the append path is actually indexed without full topology scans.

Run `nix develop --command bash scripts/test-bounded-mutations` for the focused
regressions and 10k/100k measurements under an explicitly asserted 1 GiB SBCL
heap. The graph-index workflow runs this before the complete Lisp suite. Its
measurements are evidence only after successful execution on the reported head.
PR116's standalone Nix graph workflow 38978734661 passed at 68645a7; that does
not validate this combined overlay implementation.
