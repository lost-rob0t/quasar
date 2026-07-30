# Quasar browser-first architecture

> This document describes the current PouchDB-based prototype. The
> [JavaScript-only deployment roadmap](ROADMAP.md) defines the target
> IndexedDB architecture and migration sequence; roadmap work must not treat
> the prototype storage or replication model as the target contract.
>
> [ADR 0001](adr/0001-js-package-boundaries.md) is the accepted package-boundary decision and defines the enforced dependency direction.

## Product definition

Quasar is a local-first typed investigation graph and StarIntel document workspace that runs entirely in the browser. It remains useful with no StarIntel server, Star-Lang runtime, actor system, or CouchDB connection.

The application combines four synchronized views over one local corpus:

1. graph editor and relationship explorer;
2. searchable document table;
3. canonical single-document routes and editor;
4. corpus statistics dashboard.

## Design lineage

The implementation preserves the durable boundaries from the Quasar designs in `starintel-auto-research`:

- typed documents and relations are canonical;
- renderer objects are projections, not the database;
- all durable document mutations use one reversible operation path;
- high-frequency graph movement remains browser-local until committed;
- action output is a validated document batch rather than direct renderer mutation;
- unknown or unresolved relation endpoints remain visible;
- Quasar is usable without external services.

The earlier CLOG prototype was useful for identifying those boundaries. This implementation follows its exit criteria: offline editing and frontend-specific application behavior now justify an independent JavaScript client.

## Storage

### Canonical corpus

```text
PouchDB: quasar-starintel-v09
```

Contains only StarIntel v0.9 documents. This database may replicate to CouchDB.

### Application state

```text
PouchDB: quasar-ui-state-v1
```

Contains:

- saved graph definitions and active graph;
- per-graph document membership;
- per-graph positions, viewport, layout, and selection;
- CouchDB connection settings;
- StarIntel server and RabbitMQ Web STOMP connection settings;
- browser actor manifests.

This database is not part of the StarIntel corpus and is not replicated by the application.

The default `All documents` graph has dynamic corpus membership. User-created graphs start with an empty membership list and reference canonical documents by stable ID. Graph creation, rename, switching, and deletion mutate only application state.

## Mutation pipeline

```text
manual form / graph gesture / import / actor output / queue delivery
                    |
                    v
        StarIntel v0.9 normalization
                    |
                    v
             schema validation
                    |
                    v
        reversible Quasar operation
                    |
                    v
              PouchDB commit
                    |
                    v
       graph/table/route/stat refresh
```

Document operations support save, remove, and atomic batches. Undo applies stored inverse operations. Import and actor batches are undone as one transaction.

Node drag frames remain in Cytoscape. `dragfree` commits only the final position to the Quasar workspace database.

Queue deliveries use the same batch validator and reversible operation path.
The queue is acknowledged only after validation and local persistence finish.
Accepted document IDs, including idempotently skipped existing records, are
added to the active graph workspace.

## Graph projection

- every non-relation StarIntel document becomes a node;
- every relation document becomes one or more edges from its subject/object endpoints;
- missing endpoints become unresolved placeholder nodes;
- `related_ids` become undirected related edges;
- relation confidence contributes to connection-path cost;
- positions are loaded from the active saved graph rather than written into StarIntel documents;
- one canonical document may appear in many saved graphs without being duplicated.
- canvas, node, edge, and multi-selection context menus expose graph operations
  through short hierarchical action groups with action search.

## Routes

```text
/graph                       graph workbench
/documents                   table and search
/documents/new               manual document adder
/documents/:id               canonical single-document view
/documents/:id/edit          document editor
/import                      single, bulk, and manifest upload
/stats                       corpus and graph statistics
/settings                    sync and browser actor configuration
```

## Import

The browser importer accepts:

- JSON object or array;
- JSON objects containing `documents` or `docs`;
- JSONL and NDJSON;
- CSV with envelope columns, `data` JSON, or `data.<field>` columns;
- dataset/actor manifests with referenced files supplied in the same file selection.

Validation happens before writes. Existing IDs use version/date comparison unless replacement is explicitly enabled.

## CouchDB replication

PouchDB provides:

- pull once;
- push once;
- bidirectional sync once;
- retrying live sync.

Replication applies only to the canonical corpus database.

## Map-reduce projections

Quasar installs versioned CouchDB-compatible design documents for core counts,
relation adjacency and degree, targets, messages, and events. The definitions
live in `src/lib/views.js`, install idempotently into the canonical PouchDB
database, and replicate to CouchDB with the corpus. Query helpers provide one
contract for dashboards and future table and graph projections.

## StarIntel server

The optional adapter probes the planned `/api/v1/capabilities` contract before
falling back to current gserver metadata and the legacy target route. This
compatibility layer supports today's server without freezing the future API
around its initial endpoints.

## RabbitMQ ingestion

Direct optional broker ingestion uses RabbitMQ Web STOMP because browsers
cannot speak AMQP 0-9-1 over TCP. Subscriptions use `client-individual`
acknowledgement and bounded prefetch. Invalid deliveries are negatively
acknowledged without requeue; successful and idempotently duplicate deliveries
are acknowledged after persistence.

The target architecture is a starintel-server-owned authenticated WebSocket
gateway with broker credentials, authorization, settlement, replay, and
backpressure handled server-side.

## Browser actors

Browser actors are disabled until enabled in Settings. Each actor manifest declares an identifier, label, version, accepted dtypes, and JavaScript function source.

Actors run in dedicated Web Workers. They receive cloned selection/corpus data and return declarative transform plans. The main application preflights and applies each plan as one reversible batch through the normal operation pipeline.

## Deployment

Vite produces a static application. GitHub Pages receives both `index.html` and an identical `404.html` SPA fallback so direct document routes bootstrap correctly. A runtime service worker caches same-origin application resources after first use.
