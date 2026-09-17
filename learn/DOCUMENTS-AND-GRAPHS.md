# Documents and graphs

## Documents are the intelligence records

A StarIntel document has a stable identity, a document type (`dtype`), dataset/provenance information, and type-specific data. People, organizations, locations, messages, URLs, hosts, relations, targets, and actor manifests are all represented as documents rather than separate ad-hoc browser objects.

Quasar validates document changes through its Common Lisp control plane before they become authoritative workspace state.

## Graphs are views, not a second corpus

A Quasar graph selects documents and stores presentation state such as membership, positions, viewport, layout, and groups. The underlying intelligence still lives in documents.

That separation matters: changing a node position does not rewrite the represented person or organization, and deleting a graph view does not mean deleting the intelligence record.

## A useful first graph

1. Create or import a few related documents.
2. Open the graph workspace.
3. Add those documents as graph members.
4. Add relations between the represented entities where supported.
5. Save the graph and reload the page to verify the authoritative state restores.

## Search vs workspace state

StarIntel Server owns durable backend search and document retrieval. Quasar owns its local authoritative workspace and graph state. A connected Quasar can pull/search backend records and commit selected data into a workspace without turning browser cache into the authority.

## Transactions

Related document/graph changes can be committed as one workspace transaction. Quasar applies changes to an isolated candidate first and commits the authoritative state only when the transaction validates.

Next: [Actors](ACTORS.md).
