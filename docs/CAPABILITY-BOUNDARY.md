# Quasar capability boundary

Quasar is a system, not only a browser application.

The repositories and services in the StarIntel stack have deliberately different responsibilities. `quasar-ui` is the browser presentation layer and standalone web edition. It does **not** provide the complete capability set of canonical `quasar`, `starintel-server`, or external StarIntel actor services such as `star-bbpd`.

## Stack

```text
quasar-ui
  browser UI / renderer / local standalone subset
        |
        | typed commands, projections, capability discovery
        v
quasar
  canonical Common Lisp control plane and runtime
        |
        | StarIntel APIs, document/event flows, service adapters
        v
starintel-server
  persistent backend services, ingest, storage, search, routing
        |
        | RabbitMQ actor/document routes
        +------------------------+
        |                        |
        v                        v
star-bbpd                  other actor services
  external recon actors      collectors / analyzers / tools
```

The browser is a client and projection surface when attached to the canonical runtime. It may also run by itself in an explicitly standalone mode, but standalone mode is a bounded subset rather than capability parity with the full StarIntel deployment.

## Responsibility matrix

| Component | Owns | Does not imply |
| --- | --- | --- |
| `quasar-ui` | React/Vite application shell, Cytoscape rendering, mobile/PWA behavior, local imports/exports, browser-local standalone workspaces, transient interaction state, browser-safe bounded workers | Full StarIntel backend, persistent service supervision, privileged local execution, server-side ingest/search/storage, or external reconnaissance tools |
| `quasar` | Canonical Common Lisp control plane for migrated durable operations, command/revision authority, persistent Sento supervision, privileged integrations, reconnect/replay, runtime capability discovery | That every service executes inside the Quasar process |
| `starintel-server` | Persistent StarIntel backend services, canonical document ingestion and persistence boundaries, API/search/server behavior, CouchDB/RabbitMQ integration, routing and distributed service coordination | Browser presentation or graph rendering |
| `star-bbpd` | External Python/Pykka reconnaissance actor service; consumes RabbitMQ targets, runs Subfinder, Nmap, Httpx, Katana and DNS workflows, and publishes derived StarIntel documents/relations/events | Browser-local execution or Quasar UI ownership of scanner processes |

## Connected mode

When `quasar-ui` is connected to canonical `quasar` services:

1. the browser renders state and owns transient interaction;
2. migrated durable document/graph mutations cross the Quasar command boundary;
3. persistent actors and privileged integrations run behind the runtime boundary;
4. backend ingest, persistence, search and distributed routing remain `starintel-server` responsibilities where assigned;
5. external actor services such as `star-bbpd` remain separate supervised services and communicate through the StarIntel transport/routing contracts;
6. the UI discovers available capabilities instead of assuming every deployment has every service enabled.

A missing backend or external service should reduce the advertised capability set. It must not cause the UI to pretend that a browser substitute provides the same semantics.

## Standalone web edition

`quasar-ui` remains useful without a running Common Lisp process. Standalone mode may provide local graph/document editing, imports/exports, local persistence, browser-safe actors, and supported web integrations.

That mode is intentionally not described as the complete Quasar or StarIntel runtime. Features that require durable service supervision, privileged host access, distributed queues, server-side databases/search, long-running collectors, or external tool processes require the corresponding runtime/service layer.

## External services

External services are first-class parts of the deployment topology, not hidden implementation details of the UI.

`star-bbpd` is the current concrete example. Its documented message flow is approximately:

```text
Quasar/operator/producer
  -> StarIntel target/document boundary
  -> starintel-server persistence/routing
  -> RabbitMQ actors.<actor>.new.target
  -> star-bbpd tool actor
  -> documents.ingest.<dtype> / documents.updated.<dtype>
  -> starintel-server persistence/events
  -> Quasar projections/UI
```

Quasar may expose controls, status, logs, results, and capability discovery for those services. It does not need to reimplement them in JavaScript.

## Documentation rule

Documentation must use these names consistently:

- **Quasar UI / `quasar-ui`**: browser UI and standalone web edition.
- **Quasar / `quasar`**: canonical Common Lisp control plane/runtime for migrated operations.
- **StarIntel Server / `starintel-server`**: persistent StarIntel backend services and service integration.
- **BBPD / `star-bbpd`**: external reconnaissance actor service.

Do not describe `quasar-ui` as replacing the canonical runtime or as defining the full StarIntel capability set. Do not describe the existence of the standalone web edition as forbidding a runtime-backed connected deployment.
