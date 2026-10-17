# Dataset catalog v1

`dataset.catalog` is a read-only capability. Request fields are optional:
`limit` (default 50, max 250), `byteLimit` (32 KiB–512 KiB), `scanLimit`
(default/max 1,000), `deadlineMs` (default/max 50), `expectedRevision`, `cursor`.

```json
{"revision":4,"projection":"dataset-catalog.v1","datasets":[{"name":"alpha","documentCount":12,"types":["organization","person"],"updatedAt":1700000000}],"complete":true,"cursor":null,"performance":{"mode":"bounded-graph-seek","scanned":1,"stopReason":"complete"}}
```

Names are exact canonical dataset strings, without trimming or case folding.
Only datasets containing persisted documents appear. `types` is the sorted exact
dtype set, not a sample. `updatedAt` is the maximum canonical Unix-second integer;
null means no member has a timestamp. Missing and null timestamps do not create
an index entry; zero is a real timestamp. There is no millisecond conversion.

The shared bounded seek pager uses one read transaction, revision/workspace/scope
bound opaque cursors, explicit completion (empty continuable pages are valid),
and final wire-envelope byte validation. `expectedRevision` binds the first page
to bootstrap. Stale cursors/revisions return `query.stale-cursor`; mismatched
scope returns `query.invalid-cursor`. Reads never inspect canonical documents or
graph topology. Keep only bounded visible pages; do not reconstruct a corpus.
The performance mode name is inherited from the shared catalog pager.

Derived records use `dataset-catalog-v1/` and `dataset-time-v1/` under the
workspace prefix. Each compact summary is limited to 8,192 UTF-8 bytes including
internal dtype frequencies. Timestamp frequency keys sort descending; the
maximum is one bounded seek, including after deleting the previous maximum.
Timestamps must be nonnegative integers of at most 256 bits. Oversized summaries
or timestamps return `dataset.catalog-invalid`, rolling back the entire write or
migration; nothing is truncated. These explicit index limits must be resolved by
an operator for legacy data exceeding them before bounded summaries are usable.

Create, overwrite, dataset/type/time changes, delete, full workspace replacement
and staged import promotion maintain exact counters and timestamp frequencies
inside the existing canonical Tek9 `:full` transaction. Removing the last member
removes the summary. Replayed import commits retain existing idempotency. No
transaction internals or frontend startup code are changed. #78 must preserve
`%apply-change`, the cataloged document helpers and the shared default-workspace
initialization hooks when integrating its overlay.

A never-persisted workspace returns an empty catalog. New persisted workspaces
initialize readiness atomically. Existing workspaces without the version-1
marker return `dataset.catalog-migration-required`; mutations keep canonical data
working but never publish partial legacy summaries. Explicit maintenance:

```lisp
(quasar.store:migrate-dataset-catalog store "workspace-id" :expected-revision 42)
```

Migration holds one write transaction, scans canonical documents one at a time,
rebuilds derived rows and publishes readiness only on success. Failure/restart
rolls back summaries, time indexes and marker together. It is synchronous
maintenance, not a startup request or resumable scan. Canonical records are not
rewritten. Graph and dataset migration readiness are independent.

Read cost is O(page rows) plus index seeks, independent of document count.
A document mutation touches its old/new summaries and at most two timestamp
frequencies, with bounded seeks for maxima. Dtype-map work is proportional to the
compact type set (bounded by the summary byte limit), not dataset size. Added
storage is O(datasets + distinct dataset/timestamp pairs). Migration is O(corpus)
record visits with bounded retained decode state, not a claimed constant-time job.

`dataset-catalog-tests.lisp` covers dtype counts, tied/decreasing maxima, dataset
moves, last-member/repeated deletion, rollback/restart, stale/mismatched cursors,
empty continuable pages, migration failure/retry and import overwrite. Run via
`nix develop --command npm run test:lisp`. Hosted results must match the commit;
prior graph-catalog passes do not validate the new dataset implementation.
