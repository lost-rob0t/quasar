# Melissa actors

Melissa DataSource transforms are owned by the Quasar Common Lisp control plane.

The browser no longer stores Melissa credentials, installs a Melissa actor pack, or calls Melissa endpoints from actor code. Browser actors receive only their ordinary execution context and capability API.

## Runtime ownership

The Common Lisp subsystem provides:

- typed Melissa request, lookup, normalize, forward, completion, and error messages;
- canonical `person` and `target` entities;
- a supervised Sento actor topology;
- a round-robin concurrent lookup-worker pool;
- stable request IDs and requestor preservation through the pipeline;
- backend transport for supported Melissa DataSource APIs;
- asynchronous `melissa.request` and synchronous `melissa.status` control-plane commands;
- backend-only credentials and configuration;
- worker crash detection, replacement, and router rebuild.

`QUASAR_MELISSA_LICENSE_KEY` is read by the backend. It is not a browser setting and is never placed in browser actor execution context.

## Browser boundary

The browser still owns presentation and transient execution for browser-safe actors. It does not own configured or privileged Melissa behavior.

The former browser configuration registry, Melissa actor pack, Melissa credential storage, Melissa search helpers, endpoint interception, and configuration UI are removed. Startup contains only a migration bridge that removes persisted `quasar.actor.melissa-*` actors and deletes the obsolete browser storage keys.

A regression test guards this boundary and fails if browser actor execution regains `context.configuration`, configured-context wrapping, the former actor-configuration module, or Run-all configuration gating.

## Control-plane protocol

The backend bridge registers:

- async `melissa.request`
- sync `melissa.status`

A request carries one canonical entity plus optional service options. It uses the same `quasar.control.v1` envelope as the rest of the control plane:

```json
{
  "protocol": "quasar.control.v1",
  "id": "lookup-1",
  "command": "melissa.request",
  "payload": {
    "entity": {
      "_id": "person:example",
      "dataset": "example",
      "dtype": "person",
      "title": "Example Person",
      "data": {
        "name": "Example Person"
      },
      "extensions": {}
    },
    "options": {
      "service": "personator-search"
    }
  },
  "metadata": {
    "client": "quasar-ui",
    "workspace": "default"
  }
}
```

Successful replies use the normal result envelope:

```json
{
  "protocol": "quasar.control.v1",
  "status": "ok",
  "id": "lookup-1",
  "result": {
    "_id": "person:example",
    "dataset": "example",
    "dtype": "person",
    "title": "Example Person",
    "data": {},
    "extensions": {
      "melissa.api": {}
    }
  }
}
```

Failures use the standard error envelope with code `melissa-failed`. The error details include the failing actor stage and whether retry is appropriate.

## Actor topology

The request path is:

```text
control-plane command
  -> Melissa HTTP/control-plane bridge
  -> request router
  -> round-robin lookup worker
  -> normalizer
  -> requestor forwarder
  -> original request-specific reply actor
  -> control-plane response callback
```

Each bridge request receives its own reply actor. External request IDs are correlation data, not the bridge's ownership key, so two callers may use the same external ID without stealing each other's callbacks.

Unexpected worker faults are reported to the original requestor, the failed worker terminates through Sento lifecycle handling, and the supervisor replaces it and rebuilds the worker router.

Stopping the Melissa integration fails outstanding bridge requests, unregisters both Melissa commands, and shuts down the supervised actor subsystem.

## Supported services

The backend transport currently knows these Melissa services:

- Personator Search
- People Business Search
- Personator Consumer
- Personator Identity
- Reverse GeoCoder
- Property
- Global Address
- Global Name
- Global Phone
- Global Email
- Global IP

Service selection and service-specific options belong in the control-plane request's `options` object. Credentials remain backend-only.

## Input conventions

The transport reads canonical entity data and common StarIntel aliases, including:

- person names: `full_name`, `name`, `fname`, `first_name`, `lname`, `last_name`;
- address fields: `street`, `address`, `city`, `state`, `postal`, `country`;
- contact fields: `email`, `phone`;
- Melissa identifiers: `mak`, `mik`, `melissa_address_key`, `melissa_identity_key`;
- geospatial fields: `latitude`, `lat`, `longitude`, `long`, `lng`, `lon`;
- property fields: `apn`, `fips`, `account`, `free_form`;
- network fields: `ip`, `ip_address`.

The transport checks the minimum required input for the selected service before sending a network request.

## Normalization

The normalizer preserves the original canonical entity identity and enriches supported fields from the selected Melissa record. Melissa provenance is written under `extensions["melissa.api"]`.

A record set in which every record contains an error result code is a normalization failure, not a successful empty enrichment. That failure is forwarded to the original requestor and does not produce `melissa-completed`.
