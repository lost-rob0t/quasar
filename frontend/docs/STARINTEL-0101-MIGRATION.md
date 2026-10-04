# StarIntel 0.10.1 frontend migration

The default document editor uses flat lowerCamelCase fields from the generated Star Language schema. The JavaScript consumer pins the canonical release, selects only persistent document definitions, and enforces operation cross-reference, phase DAG, scope and completion invariants. Historical imports use the explicit `starintel_doc/legacy` export; they are not relabeled canonical.

## Boundaries

- The native editor, HTTP target submission, JSONL export and Common Lisp control-plane writes use `id`, `schemaVersion`, and generated flat fields.
- PouchDB owns `_id`/`_rev`; these are stripped by its explicit adapter and never accepted as canonical wire fields. The existing database name remains unchanged, so old records are not deleted or stranded.
- Canonical records are projected explicitly into the historical graph presentation model on reads. This is an internal compatibility view, not a wire format. Graph, actor, and compact-editor writes pass the explicit migration validator before storage/transport.
- Historical relation endpoints become typed `source`/`destination` references. Decimal fields become decimal strings, Unix timestamps become seconds, and opaque maps are not recursively renamed.
- Known unmatched envelope metadata and the historical relation `active` flag are preserved under `extensions.quasarLegacy090`. Fractional historical timestamps retain their original spelling there. Reserved-key collisions and contradictory endpoint aliases reject rather than overwrite.
- Unknown historical types, unmapped fields, and invalid values are visibly gated for manual migration. These workflows are not claimed to be fully native. The historical archive export preserves unsupported records without claiming canonical validity.
- Browser JSON parsing rejects numbers that native storage cannot preserve exactly, including opaque extension values; use the canonical CLI for these documents rather than silently rounding them.

## Validation

Unit/integration tests cover canonical boundaries, identity collisions, exact-number rejection, historical metadata roundtrips, references, schema-driven editor rendering and wire payloads. The canonical Playwright journey covers create, reload, edit, cancel, JSONL export and rejection of a falsely relabeled nested payload. Local browser execution is blocked by the host socket sandbox; the supported cloud browser also rejects localhost. A passing production build or server-rendered component test is not a rendered browser pass.

No data migration job, production deployment or merge is performed by this patch. Existing specialized actor and graph authoring workflows continue through the named historical adapter; unsupported semantics require a reviewed migration rather than a cast.

## Supported workflow closure and published prerequisites

The canonical release is vendored from published StarLang commit `9198370f7a6f3e2a5ea00af3efdb6d705e102650`, whose release files are byte-identical to the previously tested local authority. Its source-backed mappings cover all 28 added executable contracts, including event, alert and research-node. These domain fields are written natively, not placed in the compatibility extension. Typed nested limits/counters/history map field-by-field; open maps retain their original keys; content validity and node creation timestamps stay separate from envelope Unix metadata. Dataset count maps become injective typed entry lists, with duplicate-key rejection.

All 28 paired field fixtures are tested in both directions. Research-runner tests persist every state transition through canonical conversion and restoration without changing state-machine, stop or accounting behavior. Original envelope metadata lacking an equivalent remains explicitly preserved. A temporary presentation-only transfer preserves other canonical envelope fields and is removed on the next wire conversion.

The frontend manifest and both workspace/standalone locks pin published JavaScript SDK `481fa64750c3af29a273d725389c13e793109a64`. Its complete generated release file hashes match the vendored Common Lisp authority. Publication verification used a fresh dependency installation, all 441 frontend tests, frontend checks, production build, and real Tek9 source-byte restart readback. These checks do not establish rendered-browser acceptance or complete release readiness.
