# Deterministic graph fixtures

The fixture API in `graph-fixtures.js` describes the persisted formats Quasar supports today:
StarIntel documents and saved graph-workspace state. It deliberately does not introduce another
graph document format.

Every fixture carries `fixtureVersion`. Increment the major version for incompatible fixture
shape changes, the minor version when adding cases, and the patch version for corrections that do
not change expectations. `fixtureManifest` records the document schema, supported serialized
formats, performance sizes, and expected round-trip behavior.

The suite includes blank, small typed cross-dataset, unknown-type, high-degree, invalid, legacy
migration, operation, revision trace, and deterministic 100/10,000-node cases. Large fixtures are
generated on demand to keep the repository small. All IDs, timestamps, ordering, and values are
fixed, so CI failures are reproducible.
