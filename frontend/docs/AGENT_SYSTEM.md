# Agent system

## Architecture

Quasar agents are persistent operator records backed by `quasar-ui-state-v1`.
Agent records never enter the StarIntel corpus and never replicate with
datasets. Versioned records cover agents, roles, providers, models, budgets,
runs, steps, checkpoints, tool calls, costs, loop events, recovery events,
structured memory, and generated actors.

The runtime is split into:

- record and migration handling in `agent-records.js`;
- provider adapters in `provider-adapters.js`;
- scoped context assembly in `agent-context.js`;
- declared tools and permission checks in `agent-tools.js`;
- graph mutation planning in `agent-graph-operations.js`;
- budgets and cost calculation in `agent-budget.js`;
- repetition detection in `agent-loop-detector.js`;
- persisted state transitions in `agent-supervisor.js`;
- the floating panel and console in `AgentSystem.jsx`.

Provider requests and graph work are asynchronous. Browser actors continue to
run in dedicated Web Workers. The UI subscribes to supervisor updates and does
not drive an uncontrolled promise chain.

## Provider adapter

All providers expose the same operations:

```text
listModels
sendMessages
streamMessages
cancel
```

Responses normalize assistant text, tool calls, usage, finish state, and the
provider-native assistant message needed for the next tool turn. Errors
normalize cancellation, authentication failure, rate limiting, server failure,
retry eligibility, and retry delay.

OpenRouter, OpenAI, custom OpenAI-compatible endpoints, and local endpoints use
the OpenAI-compatible adapter. Anthropic uses its native Messages API adapter.
Provider-specific request handling stays inside adapters.

## Keys

Provider keys use a session-scoped browser vault. They are not written to
PouchDB, StarIntel documents, agent records, graph state, prompts, logs, actor
output, or normal JSON exports. Replacing a key overwrites the session value.
Closing the browser session clears it.

Provider records contain only non-secret configuration such as provider type,
name, base URL, and enabled state.

## Tool interface

Tools declare:

- a stable name;
- a short description;
- a JSON argument schema;
- one required permission;
- a bounded executor.

The tool set includes database queries, graph queries, Brave web search, bounded
URL extraction, remote MCP calls, actor execution, custom graph building,
graph-operation preview and apply, actor validation, and validated actor save.
Tool calls store agent ID, run ID, arguments, timestamps, duration, summarized
result, affected objects, cost, and normalized error state.

Database and graph queries are bounded and dataset-scoped. The query boundary
is engine-neutral so a later WASM Prolog query engine can implement the same
document, graph, and path capabilities without changing agent tools.

## Web retrieval

`web_search` uses Brave Search with a session-scoped key. Results retain title,
URL, description, age, language, and profile metadata. The key is never added
to the request log.

`fetch_url` accepts public HTTP and HTTPS URLs, blocks loopback/private-network
targets and redirects, caps response bytes, removes executable HTML elements,
and extracts page metadata, text, and links.

`scrape_website` crawls up to 20 pages and two link levels. It stays on the
starting origin unless explicitly told otherwise, enforces a total byte cap,
records per-page errors, and reports truncation. Retrieved content remains
untrusted tool output. Browser CORS policy still applies.

## MCP servers

MCP server records contain an ID, name, Streamable HTTP endpoint, allowed tool
names, enabled state, and non-secret headers. Bearer tokens remain in the
session vault. The client implements initialize, initialized notification,
tool listing, tool calls, JSON responses, SSE responses, and MCP session IDs.

Agents must have `server.use`, the server must be assigned to that agent, and
the tool must pass the server allowlist before a call leaves Quasar.

## Skills

Agent skills are versioned persistent records with instructions, a description,
tool names, and enabled state. Skills are assigned to named agents and inserted
into the system instruction separately from run conversation history. They can
be created, edited, removed, imported, and exported with the rest of the agent
configuration.

## Permission model

The model never grants itself access. The tool registry checks the agent
permission before calling an executor. Dataset, graph, target, and actor access
lists add resource-level bounds. Destructive graph operations require the
agent's explicit `destructive` permission; otherwise the run pauses for
approval.

Actor code cannot read keys. Actors receive cloned scoped data and return
declarative transforms. Generated actor manifests are normalized, executed in a
worker against sample records, and preflighted through the existing transform
validator before they can be saved.

## Run state machine

```text
idle -> active
active -> paused | failed | stopped | completed | budget-exhausted
paused -> active | stopped
failed -> active | stopped
completed -> active
```

Each iteration:

1. checks projected budget use;
2. builds bounded structured context;
3. requests one model action;
4. executes at most four declared tool calls;
5. validates and records results;
6. calculates usage and cost;
7. records a run step and state fingerprint;
8. checks repetition and progress;
9. saves a checkpoint;
10. continues, pauses, stops, or completes.

Every completed step is persisted. A browser reload converts an interrupted
`active` run to `paused` with a resume message and retains its latest
checkpoint.

## Recovery

Retryable provider failures use bounded exponential backoff and provider retry
hints. Recovery events record attempts and errors. Runs can retry, resume from
their last persisted messages, or restore a checkpoint. Cancellation, pause,
and stop abort the active provider request.

The agent record controls retry count, backoff, smaller-context recovery, and a
fallback model ID. Recovery never bypasses permissions, validation, or budget
limits.

## Loop detection

The supervisor fingerprints normalized actions, arguments, results, errors,
messages, and corpus/graph state. It pauses on:

- repeated identical or equivalent calls;
- repeated results;
- repeated errors or messages;
- alternating action cycles;
- repeated state fingerprints with no progress.

A loop event stores the pattern and relevant recent steps. The console shows
the warning and exposes instruction editing, checkpoint restore, resume, and
stop controls. The supervisor never silently spends through a detected loop.

## Budget and cost

Run budgets enforce cost, input tokens, output tokens, tool calls, iterations,
and runtime. Agent budgets also cap daily and monthly cost. Soft limits produce
a warning; hard limits transition the run to `budget-exhausted`.

Cost records retain the exact provider usage and the pricing snapshot used for
calculation. Pricing stays outside run records so current prices can change
without changing historical cost. Exact provider usage is used when available.

## StarIntel context

Context contains only the active target IDs, selection IDs, dataset, graph,
filters, and a bounded set of relevant documents. Each document exposes object
type, sources, evidence, verification, and provenance. The builder prioritizes
selected and target documents and reports truncation limits.

The system prompt requires agents to keep sourced facts, source claims,
inference, hypotheses, user conclusions, and unverified leads distinct.

## Graph operations

Agents submit declared graph operations. Quasar first builds an exact preview,
validates documents, attaches agent/run provenance, and marks destructive
changes. Apply routes document changes through the existing operation history
and undo path. Workspace operations reuse saved graph membership, position,
layout, selection, and group state.

Supported operations cover node and relation create/update/delete, merge,
split, cross-dataset links, movement, custom graph membership, layouts,
selection focus, fit, and groups.

`build_graph` is the direct graph-construction tool. It creates a named saved
graph, selects up to 500 matching records across allowed datasets, includes
relations whose endpoints are both selected, adds the records through graph
workspace state, and applies the requested layout.
