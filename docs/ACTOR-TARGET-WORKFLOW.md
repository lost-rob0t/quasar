# Server actor Target submission (local draft)

This slice adds a recoverable submission surface to the registry browser merged in
PR #102. It does **not** implement or prove the complete actor execution journey.
PR #105 remains the Quasar WebSocket recovery implementation; this slice makes
HTTP submissions recoverable independently of local Target UI events.

## Using the surface

Configure a StarIntel endpoint and credentials in Settings, open Actor Studio,
and select a ready server actor that declares Target inputs. Enter a Target and
dataset, then submit. This creates a one-time, non-recurring canonical 0.10.1
Target command. The browser saves its immutable input and idempotency key before
POSTing. A lost response remains **outcome unknown**; explicit retry uses the
same input/key, including after page reload. Accepted receipts are displayed
without automatically submitting again. Clearing an unknown receipt requires
acknowledging the possible duplicate-work consequence.

One receipt is retained per endpoint/workspace/authentication identity in this
browser's local storage. Credentials are not copied into that receipt. Clearing
browser storage loses recovery; this is not cross-device run history or a
multi-tab transactional journal. Bearer-key rotation creates a new storage scope.

The receipt's server Target ID can be fetched directly. The exact-ID document
reader validates canonical document identity and reads only that document; it
never scans a corpus, invents result associations, or copies records into the
Quasar workspace. It can open an independently supplied output document ID, but
this is not automatic result handoff.

## Authoritative contracts inspected

- Quasar base: `3a6449a0` (full SHA in the delivery manifest).
- StarIntel server: `0137ead90ab9560b5a5090f0b62c1b59aac08c68`.
- `source/frontends/http-target-v1.lisp` and `http-target-v1-route.lisp`:
  `POST /api/v1/targets`, JSON-object `options`, body `idempotency_key`, and
  `accepted` / `duplicate` receipts with `target_id` and `request_id`.
- `http-auth-routes.lisp`: username/password exchanged at `/auth/login` for an
  in-memory bearer API key. A 401 clears the cached login; a subsequent explicit
  operation logs in again. No automatic POST retry is introduced.
- `http-contract-routes.lisp`: exact `GET /api/v1/documents/:id`.
- StarLang schema authority verified by the vendored checker at
  `9198370f7a6f3e2a5ea00af3efdb6d705e102650`, release 0.10.1.

The older client fixture used array options. It now follows this inspected
canonical server version. No `Idempotency-Key` header is added. Submission never
falls back to the legacy non-idempotent route, including on HTTP 404. Older
servers therefore fail visibly rather than silently scheduling different work.
Public capabilities discovery sends no credentials; only 404/405 permit legacy
discovery, which retains legacy Basic authentication. Authorization errors are
not treated as evidence of a legacy server.

PR #68 overlaps the shared HTTP client. Reconcile it against the canonical server
version above before publishing; its older advertised `target_create` legacy
route does not provide this v1 receipt/idempotency contract. No commits from #68,
#100, #104, or #109 were applied or modified.

## Missing execution contract

The inspected server's public capabilities and routes provide acceptance and
document reads, but no per-Target execution-progress/result-reference query.
Neither acceptance, an actor's registry liveness, nor a locally created Target
proves actor execution. The UI explicitly reports that execution status is
unavailable. No synthetic progress, completion, or result IDs enter production
code.

Completing the accepted journey requires a server-owned, principal-authorized
Target/run observation contract with durable execution state, an event cursor,
and explicit result-document identities. Then the UI can resume observation
across server restarts and fetch those exact results. This needs owner-side
contract work; this change does not close #92, #95, or #97.

## Validation commands

Use the repository shell as required by AGENTS.md:

```sh
nix develop --command npm ci
nix develop --command npm run check
nix develop --command npm --prefix frontend run test:unit -- --maxWorkers=1 --testTimeout=30000
nix develop --command npm run build
nix develop --command npm run test:actor-workflow
```

For a shell-provided Chromium, set `QUASAR_CHROMIUM_PATH` to its executable.
The longer unit timeout accommodates expensive schema-validation cold starts;
it does not change committed test defaults.

`test:actor-workflow` is a **synthetic HTTP/component journey**, not a full-stack
execution test. It mounts the production ActorManager and HTTP client with a
fixture store and starts a loopback HTTP fixture. Both desktop and 390px viewport
cases exercise actor discovery/selection, submission, lost responses, offline
retry, real fixture-process termination/restart with persisted acceptance,
page reload, deduplication, exact Target/document reads, and no horizontal
overflow. Output screenshots and synthetic acceptance ledgers are written to
`artifacts/actor-workflow-browser/`. This test does not start Quasar Lisp/Tek9,
StarIntel, or an actual actor; no result document is evidence of execution.

The delivery report records checks actually run, environment restrictions and
any failures. No skipped live test is counted as a pass. Android emulator,
native Android parity, physical-phone behavior, Quasar WebSocket reconnect,
real actor execution, and actual stack crash/restart remain unverified here.
