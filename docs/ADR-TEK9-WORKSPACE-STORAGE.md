# ADR: Tek9 as Quasar's local workspace store

Status: accepted for Phase 1 of issue #24

## Context

Quasar's Common Lisp control plane already owns canonical command validation,
single-writer mutation ordering, workspace revisioning, transactions, journal
construction, graph/document referential integrity, reconnect recovery, and
event ordering. Its original `memory-store` preserved those application
semantics but could not survive process death.

Issue #24 requires durable workspace storage and ultimately bounded-memory
streaming imports. The backend choice for this effort is Tek9, an embedded
Common Lisp document and graph database backed by LMDB.

## Decision

Tek9 is Quasar's canonical local embedded persistence engine. LMDB is used only
through Tek9. Quasar does not introduce a parallel database abstraction and does
not make CouchDB, PouchDB, or Cytoscape a local mutation authority.

The dependency direction is:

```text
React / Cytoscape
        |
quasar.control.v1
        |
Quasar Common Lisp control plane
        |
Sento single-writer actor
        |
workspace-store + typed persistence plan
        |
Tek9
        |
LMDB
```

Quasar consumes only exported Tek9 APIs. Tek9 remains generic and contains no
Quasar-specific commands, schemas, or business validation.

## Atomic commit boundary

Quasar applies and validates a command or complete workspace transaction to an
isolated candidate first. A typed persistence plan is then derived from the
canonical applied result. It contains only the changed document, graph metadata,
node, edge, and deletion records.

One `commit-workspace` call opens one composable Tek9 write transaction. The
following effects commit or abort together:

- document upserts/deletes;
- named-graph metadata changes;
- graph/v2 node/edge/topology/adjacency changes;
- canonical node/edge sidecars;
- workspace revision/settings metadata;
- one append-only journal entry.

The durable base revision is checked inside that transaction. The in-memory
candidate is installed and events are broadcast only after durable commit
succeeds.

## Schema version 1

The schema has a global version marker plus a per-workspace version marker.
Unknown versions fail closed.

Stable length-prefixed workspace namespaces own:

- one workspace metadata record;
- one Tek9 record per StarIntel document;
- one named-graph metadata record per graph;
- one canonical node sidecar per node;
- one canonical edge sidecar per edge;
- one ordered journal record per commit.

Graph topology itself is stored through Tek9 graph/v2 in a logical namespace
derived from workspace ID + graph ID. Internal Tek9 row IDs, DBI names, and
adjacency encoding remain private.

Node and edge sidecars are needed because Quasar's canonical view records can
contain application fields beyond Tek9's generic graph topology shape. The
sidecars do not duplicate adjacency or define another topology authority.

## Performance constraints

Normal single-record mutations do not serialize or diff the entire workspace
and do not scan/rewrite the full document corpus. Record-level changes are
captured while the already-authoritative candidate is being applied.

Graph replacement may rewrite that one graph namespace. Workspace recovery may
scan the workspace's own ordered record prefixes. Those are explicit bulk/read
operations rather than hidden cost on ordinary mutations.

Canonical state uses Tek9 `:full` durability. Performance gates must not be won
by selecting `:nosync`.

## Lifetime and location

One Tek9 environment remains open for the Quasar application lifetime and is
closed during shutdown.

The default location is:

- `$XDG_DATA_HOME/quasar/tek9/`, or
- `~/.local/share/quasar/tek9/` when `XDG_DATA_HOME` is unset.

Tests and deployments may override the path or inject an already-created store.

## Migration

Before this decision Quasar's production `memory-store` had no process-durable
local data. There is therefore no durable memory-store data set to migrate.
Existing ephemeral state disappears on process exit by definition.

Future schema changes must introduce an explicit migration/version path. A newer
unknown schema must not be silently interpreted as schema 1.

## Phase boundary

This ADR deliberately does not claim all of issue #24 is complete. During this
phase the active workspace is still fully materialized in SBCL, and import
sessions still retain a copied workspace plus encoded chunks in memory.

The next coherent phase is to move document reads, paginated snapshots, and
import staging directly onto Tek9, adding durable chunk staging, backpressure,
restart recovery, abandoned-stage cleanup, and memory/throughput telemetry
without replacing schema 1's canonical document/graph representation.
