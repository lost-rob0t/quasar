# Target-driven actors

Quasar treats a newly saved `target` document as an explicit actor input. It does not let browser actors mutate Cytoscape, PouchDB, or workspace state directly.

## Creation flow

1. Save and validate the target document.
2. Select bundled or enabled actors that declare the `target:create` trigger.
3. Include any local actor IDs explicitly named by `data.actor` or `data.actors`.
4. Execute each actor with the new target as its explicit selection, even before the React document list refreshes.
5. Normalize returned documents and transform operations.
6. Apply them through the standard transaction, provenance, graph-membership, and undo path.
7. Keep the target saved if an actor fails and report the failed actor separately.

## Bundled target actors

### Expand target inputs

`quasar.actor.target-input-expansion` runs on target creation. It classifies target values as URLs, domains, email addresses, usernames, StarIntel document references, or search terms. It creates typed entities where needed and explicit `targets` relations from the target document.

### Load city Legistar calendar

`quasar.actor.city-legistar-calendar` is manually selectable or explicitly requested by a target. It resolves a Legistar client from fields such as `legistar_client`, `client`, `city`, `municipality`, `target`, or a Legistar URL. The actor then retrieves a bounded public event set from the official Legistar API and returns event and relation documents.

The actor is not tied to Columbus. A target such as `Columbus, Ohio`, `New York`, `https://chicago.legistar.com/Calendar.aspx`, or an official `webapi.legistar.com/v1/<client>` URL determines the client dynamically.

## Existing actors

Username candidate generation and WhatsMyName preparation accept target documents when the target is explicitly typed as a username/handle or starts with `@`. Existing normalize-name, related-ID, derived-node, and verification actors remain available through normal graph selection.
