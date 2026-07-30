# Audit remediation boundaries

This branch contains the immediate security, integrity, reliability, and CI remediation from the July 2026 Quasar audit.

## Security containment

- Provider, Brave Search, MCP, and gateway credentials are session-scoped and bound to the reviewed endpoint identity.
- Built-in provider identifiers cannot be redirected to alternate endpoints.
- Imported and generated browser actor source is disabled until the opaque-origin actor runtime is implemented.
- Actor network access is limited to bounded HTTPS `GET` and `HEAD` requests without redirects, credential headers, or private literal addresses.
- Agent arbitrary URL fetch and crawl operations require a trusted server-side gateway.
- The service worker caches only application shell and immutable static assets.

## Integrity containment

- Agent records are listed from primary prefix-addressed records instead of a separately mutated secondary index.
- A failed compensating document-batch rollback throws `PARTIAL_BATCH_COMMIT` with the surviving writes and requires repair.
- Cost-budgeted remote model execution requires known pricing before a request is sent.
- Explicit zero limits are hard stops rather than unlimited values.

## Reliability improvements

- JSONL imports use streaming parsing where browser streams are available and enforce file, byte, record, document, and retained-error limits.
- File-like environments without stream support use the same bounded validation contract through a compatibility fallback.
- Repository-wide Prettier coverage is enforced through `.prettierignore` rather than a partial path list.

## Remaining architecture work

These changes deliberately fail closed, but they do not replace the larger target designs:

- opaque-origin sandboxed actor execution;
- a server-side fetch gateway that validates DNS and every redirect hop;
- journaled logical document transactions;
- worker-based chunk staging and resumable imports;
- serialized global cost reservations for concurrent agent runs.
