# Authoritative dashboard statistics

`workspace.statistics` is a bounded authenticated workspace command. It reads
maintained records in one Tek9 read transaction, never canonical documents or a
hydrated workspace. Capability `workspace.statistics` is required.

## Summary

Request: `{section:"summary", expectedRevision?, byteLimit?}`. Byte budget defaults
to 524288, allowed 32768–524288 including the response envelope. Response:

```json
{
  "revision": 3,
  "projection": "workspace-statistics.v1",
  "statistics": {
    "documents": 2,
    "reviewedDocuments": 1,
    "unreviewedDocuments": 1,
    "reviewedEntities": 1,
    "reviewedRelations": 0,
    "reviewedEvents": 0,
    "reviewedInvestigationTargets": 0,
    "reviewPercent": 50,
    "reviewedByDtype": {"person": 1},
    "unreviewedByDtype": {"person": 1},
    "topConnected": [{"id":"alice", "label":"Alice", "count":0}]
  }
}
```

Counts are exact integers, not estimates from a loaded page. Review percentage is
positive half-up rounding (`Math.round`) or zero for an empty workspace. Dtype
maps omit zero entries. Top connected contains at most 12 nodes, including zero
degree reviewed nonrelation nodes and unresolved references.

## Reviewed datasets

Request: `{section:"datasets", expectedRevision?, limit?, byteLimit?, cursor?,
scanLimit?, deadlineMs?}`. Same budgets as `dataset.catalog` (50 default rows,
250 max, 1000 scanned rows, 50 ms). Response:
`{revision, projection:"workspace-statistics-datasets.v1",
datasets:[{name,documentCount}], complete, cursor, performance}`.
Only REVIEWED documents count. Zero-reviewed datasets are omitted. Order is
count descending then exact name in UTF-8 lexical order. Replace the visible page;
do not drain it. A deadline may yield an empty continuable page. Cursor is null
exactly when complete; cursors bind workspace, section and revision. Use the summary
revision as expectedRevision on dataset pages; stale revisions reject with
`query.stale-cursor`. `dataset.catalog` remains the distinct all-document catalog.

## Semantics and deterministic ties

The semantic authority is `toLegacyUiDocument` followed by `reviewState`,
`buildGraph`, and `graphStatistics`. Review metadata is the preserved top-level
`extensions.quasarLegacy090.verification`. `verified:true/false` wins; then the
normalized accepted statuses, then truthy `last_reviewed_at`. Canonical
`verificationStatus`/`verifiedAt` are not promoted into this legacy field.
The adapter leaves dtype unchanged: canonical `organization` does NOT count as
legacy `org` in reviewedEntities. Entity set: entity/person/org; event set:
event/meeting; target set: investigation-target/target. This matches the current
frontend even where its historical categories are surprising.

Labels use preserved top-level title, then adapter data display_label,
canonical_name, display_name, full_name, name, domain, url, target, then ID;
target tips retain the adapter title override. The pinned workflow mapping and
Document schema determine presentation fields. Relation endpoints use adapter
subject/source and object/target, cross-product edges without deduplication;
nonrelation related_ids come from preserved legacy metadata. Duplicate edges
count repeatedly; self-loops increment degree twice. Referenced unreviewed,
missing or relation documents appear as unresolved nodes with their ID as label.

Stable degree ties are defined against canonical Tek9 document-primary-key
traversal (`%key-part`, length-prefixed IDs), then buildGraph node insertion:
reviewed nonrelation nodes first, relation endpoints next, related_ids last.
Endpoint ordinal breaks ties within one contributing document. This deterministic
ordering may differ from historical transient hash insertion order; an oracle
comparison must order its canonical input accordingly. It remains stable across
restart, update, deletion and migration.

## Atomic indexes, readiness and costs

Document create/update/delete and staged import promotion maintain the summary,
reviewed dataset counts/ranks, node degrees/ranks, and ordered per-node endpoint
witnesses in the existing canonical write transaction. Failure rolls all of them
back with canonical state. Removing the earliest reference finds the next witness
with one bounded seek; unresolved/resolved transitions update labels and rank.
No transaction-overlay internals are changed.

Fresh workspaces initialize readiness. Existing workspaces without version 1
return `workspace.statistics-migration-required`. An operator explicitly invokes
`(quasar.store:migrate-workspace-statistics store workspace-id
 :expected-revision revision)`. It rebuilds in one write transaction, one canonical
record per bounded seek, and publishes readiness last. Failure hook
`:before-statistics-ready` verifies rollback. It is never run by startup or reads.
This maintenance operation is O(documents + reviewed endpoint occurrences) and
can hold a long write transaction; schedule it explicitly.

Summary read: fixed fetches plus a range of at most 12 rank rows, O(12 log N)
seek cost and bounded response memory. Dataset read: O(page size log N), with
explicit scan/time/byte bounds. Mutation work is proportional to old and new
reviewed endpoint occurrences, with O(log N) index operations per occurrence,
not the corpus size. Index storage is O(documents + endpoint occurrences +
datasets); review/type summary maps are capped by the record bound. This is a
write/storage cost increase in exchange for bounded authoritative reads.

Derived records are limited to 8192 UTF-8 bytes, complete keys to 500 bytes,
counters to unsigned 256-bit integers and per-document endpoint ordinal to
unsigned 64 bits. Non-string reviewed graph labels/endpoints or overflowing
representations fail explicitly with `workspace.statistics-invalid` and roll back;
no truncation or approximate counts. Summary too large for the requested wire
budget fails with `query.record-too-large`. These constraints also apply to
migration, so an incompatible legacy record cannot produce a partial dashboard.
