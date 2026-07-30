# Research nodes

A research node is a graph-native executable investigation plan. It is not a note, a chat session, or an opaque autonomous agent.

## StarIntel representation

Research nodes use the canonical StarIntel v0.9 `research-node` object type:

```json
{
  "_id": "starintel:research-node:example",
  "dataset": "default",
  "dtype": "research-node",
  "schema_version": "0.9.0",
  "version": 1,
  "date_added": "2026-07-26T21:00:00Z",
  "date_updated": "2026-07-26T21:00:00Z",
  "title": "Map the program",
  "summary": "Map an organization and the people responsible for a program.",
  "status": "draft",
  "sources": [],
  "evidence": [],
  "data": {
    "objective": "Map an organization and the people responsible for a program.",
    "instructions": "Prefer primary records and preserve provenance.",
    "status": "draft",
    "input_ids": [],
    "target_ids": [],
    "actor_ids": [],
    "actor_selection_rules": [],
    "output_ids": [],
    "artifact_ids": [],
    "child_ids": [],
    "dependency_ids": [],
    "run_ids": [],
    "current_actor_id": "",
    "current_run_id": "",
    "limits": {},
    "stop": {},
    "counters": {},
    "history": [],
    "created_at": "2026-07-26T21:00:00Z",
    "started_at": null,
    "completed_at": null,
    "last_error": "",
    "paused_reason": ""
  }
}
```

The object type is defined by the shared StarIntel schema and exercised by the Python, JavaScript, Common Lisp, and Nim conformance adapters. Quasar does not maintain a private research-node shape.

## State machine

`draft -> queued -> running`

A running node may become `paused`, `blocked`, `completed`, `failed`, or `killed`. Failed, killed, completed, paused, and blocked nodes can be queued or run again. Every transition is appended to bounded `data.history`.

## Graph edges

Use explicit relation documents when an edge matters to traversal or provenance:

- `researches`: research node to input or target
- `uses-actor`: research node to an actor document
- `depends-on`: research node to another research node
- `produced`: research node to output document
- `spawned`: parent research node to child research node

The research node caches IDs needed by the executor. Relation documents remain the graph authority.

## Execution

1. Resolve input documents and ordered actors.
2. Check depth, run, request, elapsed-time, repeat-state, and optional cost limits.
3. Execute each actor through the browser actor runtime.
4. Validate returned documents and transform operations.
5. Apply mutations through the existing command and undo path.
6. Link outputs and artifacts to the research node and actor run.
7. Stop when the actor queue is empty, no new documents are produced, the objective is satisfied, or a configured failure rule fires.

Actors do not receive Cytoscape or PouchDB handles.

Quasar runs the ordered queue through `quasar.browser-js.v1`. Ambient worker network APIs are disabled. Actors must declare capabilities such as `network.fetch`, and every capability request is counted against the research-node request limit. Each lifecycle transition is validated and persisted through the normal command/undo path.

The runner blocks before unsafe continuation when a dependency is incomplete, an actor is missing, or an actor-run, request, elapsed-time, repeat-state, or cost limit is reached. Pause and kill abort the active worker. Resume continues the interrupted actor, while retry continues the failed or blocked actor.

## UI

The graph context menu can create a research node from current selection. The compact editor shows objective, inputs, actor queue, limits, and run controls. The full editor exposes stop rules, counters, and history.

State is visible on the node without hard-coding colors that override the active theme. The compact editor, graph context menu, and inspector expose `run`, `pause`, `resume`, `retry`, and `kill`; the graph context menu also exposes `inspect outputs` and `clone`.

Selecting a research node should support a focused subgraph containing inputs, actors, outputs, artifacts, dependencies, and child nodes.

## Provenance

Every actor run records:

- research node ID
- actor ID and version
- input IDs
- output IDs
- capability requests
- start and finish timestamps
- terminal state and error

Generated documents retain `quasar.actor` provenance and reference the research node and run ID.
