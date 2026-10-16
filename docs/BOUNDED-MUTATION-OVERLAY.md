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
records and recomputes sizes of explicitly touched graphs in bounded batches.
Settings, workspace ID and revision overhead are included exactly. The quota
callback runs inside the write transaction before metadata/journal commit;
rejection rolls back records and accounting together. Explicit save-workspace
replacement initializes accounting within its existing write transaction.

## Remaining acceptance gaps

This is not completion of #78 and is not merge-ready without runtime checks.

- Missing legacy accounting or a revision changed by the old staged-import
  writer triggers a bounded-memory accounting scan. Total work/allocation is
  still proportional to corpus size on that upgrade/post-import path. Import
  promotion must maintain the same accounting atomically before the strict
  cold/post-import allocation requirement can pass.
- Graph quota recomputation scans topology of each touched graph. Per-record
  graph counters should be coordinated with #111's catalog work.
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
