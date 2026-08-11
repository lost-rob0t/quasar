# ADR 0002: Capability-scoped browser JavaScript actors

## Status

Proposed and partially implemented.

## Context

Quasar currently executes actor source strings in one-shot Web Workers. That provides timeout and memory separation, but the contract is still a local helper: actors receive cloned corpus data and return documents. Research nodes, packaged actors, agent-created actors, browser operations, and reusable actor tooling need a stable runtime boundary.

Direct access to Cytoscape or PouchDB would make actors impossible to validate, undo, replay, or audit. Direct ambient browser APIs also make permissions and resource limits unclear.

## Decision

Introduce `quasar.browser-js.v1`.

A manifest declares source, accepted object types, selection bounds, capabilities, and hard limits. A dedicated worker runs `implementation(context, api)`. Effects are requested from the host over message RPC.

Initial capabilities are:

- `documents.get`
- `documents.query`
- `network.fetch`
- `browser.open`
- `events.emit`
- `artifacts.write`

The host denies undeclared or unavailable capabilities. Results use one envelope containing documents, transform operations, artifacts, message, and metrics. Lifecycle events expose start, progress, logs, capability requests, completion, timeout, abort, failure, and crash.

Existing actor manifests are adapted with no capabilities and keep their current source functions.

## Security boundary

This runtime is a capability and resource boundary, not a complete hostile-code sandbox. The worker bootstrap removes obvious ambient network APIs, but browser JavaScript still has escape surfaces such as dynamic import and engine behavior outside this contract.

Truly untrusted third-party actors require stronger isolation: a separate origin, SES/Compartment, or a server-side runner. Quasar must label trust level instead of pretending a Blob worker is a security sandbox.

## Consequences

- Actor effects become observable, deny-by-default, and mockable in tests.
- Research nodes can compose actors without handing over database or graph objects.
- Existing actors can migrate incrementally.
- Host services must serialize bounded responses.
- Actor packages will need signing and trust metadata in a later ADR.

## Migration

1. Land manifest normalization, worker bootstrap, RPC, result bounds, and tests.
2. Adapt `runBrowserActor` to call the runtime with no capabilities.
3. Move document reads and browser/network operations to host services.
4. Add actor run records and research-node orchestration.
5. Add isolated-origin or SES execution before accepting untrusted actor packages.
