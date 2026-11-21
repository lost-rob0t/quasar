# Flow studio foundation

Open **Code studio** (`/code`) and scroll to **Flow studio**. The initial flow
injects `[1,2,3,4]`, doubles each value, retains values at least five, and logs
`[6,8]`. This is a local executable preview, not a deployed actor or daemon.

## Authoring

Use the searchable palette to add nodes. Drag a node header, or edit X/Y with the
keyboard. Select a node to edit its label, configuration JSON, and (for language
nodes) source. Apply configuration before running. Each node's help describes its
configuration and execution status.

Choose an output and an input using port buttons or the labeled connection
selectors, then click **Connect**. Connections can be removed individually;
deleting a node removes its incident edges. Typed ports are declared in the
catalog. JSON outputs are dynamic and checked against the destination's actual
input type at delivery. Invalid ports, missing nodes, duplicate wires, incompatible
concrete types and cycles reject. All nodes expose an `error` output. An unwired
node failure stops the run; a wired failure emits `{nodeId,message}` on that port.
Budget violations still stop when there is no room to deliver an error.

**Save flow** persists one versioned graph in this browser only. Save explicitly
after editing; configuration drafts must first be applied. Import/export uses
Quasar flow JSON version 1 (`name`, `nodes`, `edges`), retaining positions, labels,
configurations and named endpoints. Invalid imports preserve the open graph.
The format is not Node-RED JSON and is not a canonical StarIntel workflow document.
No workspace document or server record is written by Save or Run.

## Executable catalog

| Nodes | Preview behavior |
| --- | --- |
| Inject / Debug | One configured JSON value per run / bounded trace output |
| Map | Array identity, own-property get, numeric add/multiply, wrap in `{value}` |
| Filter / Switch | Declarative eq, neq, gt, gte, lt, lte, exists, string contains; Filter retains matching array items or passes one matching scalar; Switch routes match/otherwise |
| Change | Clone an object and set one safe top-level field |
| Split / Join | Stable ordered array splitting / fixed-count grouping; incomplete groups fail |
| Concat | FIFO pairing of left/right arrays; left precedes right; unpaired inputs fail |
| Merge / Deduplicate / Take | Forward arrivals / first JSON-serialized key per run / at most count arrivals |
| Delay | 0–1,000ms cancellable delay for each arrival |
| JSON parse / stringify | Strict JSON conversion; parse errors route or fail |
| StarIntel validate / field | Existing repository-locked canonical schema assertion / own-property field read after validation |
| JavaScript | Explicit session opt-in, using the existing opaque-origin actor sandbox; function `(payload) => JSON`, no granted capabilities |

The canonical validator uses the existing `starintel_doc` authority through
`src/flows/index.ts`; it accepts flat 0.10.1 records and rejects nested historical
shapes. It does not migrate them. For example, a Person name is `fullName`, not
`data.full_name`. StarIntel field defaults to `id`.

## Trusted adapter contracts, disabled by default

The palette also contains Common Lisp, Prolog, StarLang, RabbitMQ, ZMQ, TCP, HTTP,
and StarIntel search/target/actor nodes. They retain source/configuration and
participate in typed graph validation, but are **adapter contracts**, not bundled
language engines, transport clients or server integrations. Run fails visibly
unless the caller supplies both a matching adapter function and its exact grant.
The shipped UI supplies only the optional isolated JavaScript adapter.

```ts
import { runFlow } from "../src/flows/runtime";

await runFlow(flow, {
  grants: ["code.prolog"],
  adapters: {
    "code.prolog": async ({ node, payload, signal }) => {
      // Resolve a trusted bounded host runtime here. This example is a fixture.
      signal.throwIfAborted();
      if (!node.config.source) throw new Error("Missing source");
      return { fixture: payload };
    }
  }
});
```

The graph cannot grant itself execution authority. Imported configuration is not
a grant. Do not pass transport credentials through flow JSON; transport nodes
use `connectionRef` and optional `channel`, resolved by a trusted host adapter.
Inline credential/URL configuration keys are rejected. This is not a secret
scanner: authors must not paste secrets into source or other arbitrary strings.
A future host adapter must enforce its own destinations, principal/workspace
capabilities, result bounds, language isolation, and cancellation. It must not
expose unrestricted Lisp, process execution or a network socket to browser code.
A timeout stops preview routing and aborts the signal; the preview cannot kill an
uncooperative trusted host process or undo an already completed external action.

JavaScript runs through `createOpaqueOriginBrowserActorRuntime`, using the existing
`allow-scripts` iframe sandbox, capability checks, worker timeout and cleanup.
The wrapper returns payload through bounded actor metrics. No services or
capabilities are supplied; the existing sandbox implementation is unchanged.
Browser tests demonstrate `typeof fetch === "undefined"`, infinite-loop timeout,
exception reporting and removal of the sandbox iframe. This is evidence of this
integration, not a new sandbox security audit.

Existing RabbitMQ/STOMP ingestion (`src/lib/rabbitmq-ingest.js`) and its Settings
configuration are unchanged. No production broker, server, endpoint, credentials,
deployment or connection was used for this work.

## Execution limits and semantics

Flows are acyclic. Every run creates fresh state and clones the graph, messages
and adapter inputs, preserving branches from mutation. Inject roots run in node
order and messages are delivered through a stable FIFO queue. Async processing
is sequential. Concat pairs by arrival on each named port; there is no implicit
join by topic, correlation ID or event time.

Hard limits: 128 nodes, 512 edges, 1 MiB serialized graph, safe finite JSON nesting
at most 32, 256 KiB per payload, 2,048 emitted messages, 4,096 delivery steps,
4 MiB cumulative retained-byte accounting, and 10 seconds per preview. Fanout is
accounted before queueing. The byte counter is conservative and cumulative, so
it can reject a run whose live heap would be smaller. JS has a separate two-second
sandbox limit. Stop and component unmount abort the run; late adapter results do
not route. These are authoring limits, not corpus-scale or live-stream throughput
claims. The editor does not read or hydrate any document corpus.

## Inventory and follow-up scope

Inspected main's CodeWorkbench, code validation/editor, browser/opaque-origin
actor runtimes, canonical document boundary and RabbitMQ ingestion before adding
this module. PR #110 owns actor Target submission, not this editor. The separate
`node-red-starintel` checkout already has Node-RED runtime nodes (input, emit,
filter, documents, target, actors, Pro actors, operations, RLM, UI, flow manager,
server configuration and message2org); this change does not import their Node.js
runtime into Quasar's browser or claim parity with them.

Further work includes trusted server runtime/transport adapters with authority
and lifecycle tests; live sources/subscriptions, ack/retry/dead-letter semantics;
subflows and reusable typed contracts; persistent schedules, durable replay and
backpressure; Node-RED import/conversion and explicit compatibility inventory;
additional file/HTTP/WebSocket/UDP/MQTT nodes; reduce/batch/window/rate-limit and
correlation joins; richer expression/source editing and run stepping. The open
ended Node-RED ecosystem is not fully implemented by these 28 catalog entries.

## Validation

AGENTS.md requires the Nix shell. Reproduce in an environment with Nix:

```sh
nix develop --command npm run check
nix develop --command npm run test:lisp
nix develop --command npm --prefix frontend run test:unit -- --maxWorkers=1 --testTimeout=30000
nix develop --command npm --prefix frontend run test:integration
nix develop --command npm run build
nix develop --command bash -c 'cd frontend && npx playwright test --config tests/browser/flow-editor/playwright.config.ts'
```

`QUASAR_CHROMIUM_EXECUTABLE_PATH` selects Chromium for the focused browser fixture
(default `/usr/bin/chromium`). The fixture mounts the production CodeWorkbench,
FlowEditor, catalog, runtime, schema boundary and JS sandbox. It uses no backend,
network adapter or production data. Screenshots and traces are in
`frontend/test-results/flow-editor/` (gitignored).

This task's managed environment has no Nix (`nix: command not found`, exit 127).
Host checks are supplemental; Lisp/native/full-stack and Nix checks remain unrun.
Keep the PR draft until the required environment checks and review are complete.
