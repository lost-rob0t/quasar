# Quasar ↔ Prolog IO v1

`quasar.prolog.io.v1` is a narrow reasoning boundary over the canonical Quasar
workspace. Tek9/LMDB remains durable authority and the Sento control-plane actor
remains the only mutation authority.

## Commands

### `prolog.snapshot`

Returns a deterministic, bounded projection of canonical StarIntel documents.

Input:

```json
{
  "offset": 0,
  "limit": 250,
  "documentIds": ["starintel:person:example"],
  "dtypes": ["person", "relation"]
}
```

`limit` is capped at 1000. Documents are sorted by `_id`. The response
includes the workspace revision so a reasoning process can bind conclusions to
the exact state it observed.

### `prolog.proposal.validate`

Dry-runs ordinary Quasar operations against a copy of the current workspace.

Input:

```json
{
  "expectedRevision": 42,
  "operations": [
    {
      "type": "document.create",
      "payload": {
        "_id": "starintel:relation:example",
        "dtype": "relation"
      }
    }
  ]
}
```

The command never commits. If validation succeeds, a caller that has normal
write authority may submit the same operations through `workspace.transaction`.
Revision checking prevents a proposal produced from stale facts from being
silently promoted.

## Security boundary

The interface intentionally does **not** expose:

- arbitrary Prolog goals;
- `consult/1`, shell execution, file access, or process spawning;
- StarLang loading;
- direct Tek9 access;
- a hidden write path.

Prolog reasons over projected canonical state and emits typed Quasar operation
proposals. Quasar validates and, only through its existing authority path,
commits accepted operations.

## Intended Prolog predicates

A Prolog adapter should normalize the snapshot into predicates similar to:

```prolog
document(Workspace, Revision, Id, DType).
relation(Workspace, Revision, RelationId, Subject, Predicate, Object).
source(RelationId, SourceId).
evidence(RelationId, EvidenceId, Confidence).
```

Every derived conclusion should retain `Workspace`, `Revision`, supporting
document IDs, rule/expert version, and an explanation. Derived relations should
be proposals rather than asserted canonical facts until Quasar accepts them.
