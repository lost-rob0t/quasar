# Learn Quasar + StarIntel

This directory is the guided learning path for people using the complete local Quasar + StarIntel stack.

You do not need to understand the Common Lisp control plane, CouchDB internals, RabbitMQ routing, or actor implementation details before using the product.

## Path

1. [First run](FIRST-RUN.md) — install, start, log in, and verify the stack.
2. [Documents and graphs](DOCUMENTS-AND-GRAPHS.md) — understand StarIntel documents and Quasar graph workspaces.
3. [Actors](ACTORS.md) — understand manifests, targets, outputs, and why actor execution is separate from the browser.

## Mental model

StarIntel documents are the intelligence records. Quasar is the workspace and control plane that lets you inspect, create, relate, search, and visualize those records. Actors receive targets and emit more documents back into StarIntel.

```text
target
  |
  v
actor ---> StarIntel documents ---> Quasar workspace / graph
             ^                         |
             |                         |
             `------ search/query <----'
```

The graph is a view over intelligence documents, not a replacement database.

## Where to go deeper

Once the tutorials make sense:

- `wiki/` explains installation and operations.
- `docs/ARCHITECTURE.md` explains runtime ownership.
- `docs/CAPABILITY-BOUNDARY.md` explains what belongs in Quasar, StarIntel Server, and external actors.
