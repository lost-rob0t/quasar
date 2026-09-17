# Actors

Actors are runtime components that receive typed messages and produce typed outputs through StarIntel service boundaries.

## Actor manifest

An actor manifest describes an actor's identity, accepted message shapes, runtime location, and non-secret configuration schema. Quasar can discover these manifests from the actor registry and render a consistent control surface without hard-coding every implementation.

## Message flow

```text
Quasar / client
    |
    v
StarIntel service boundary
    |
    v
actor runtime
    |
    v
StarIntel document boundary
    |
    v
workspace / search / graph
```

The manifest is the semantic contract. A queue, WebSocket, or other transport is only a delivery mechanism and does not define actor identity.

## Base install vs actor packs

The base end-user package intentionally starts no optional actor fleet. This keeps first install small and predictable. Public actor packs can be installed separately while using the same manifest and message contracts.

Historically separate Pro actors can move into the public actor collection without changing Quasar's actor model. Explicit core-private exceptions remain outside that public collection.
