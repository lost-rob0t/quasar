# Wireless imports: bounded first slice

The native desktop Import page now accepts explicit WiGLE CSV and Kismet device
JSON/JSONL in addition to canonical StarIntel documents. Canonical 0.10.1
validation remains the authoritative boundary. The existing Quasar control-plane
staged Tek9 transaction path owns persistence; this adapter does not write a
second database or add collection/network lookup behavior.

## `quasar.wireless-import.v1`

- A source format and target dataset are explicit inputs.
- Original source bytes are retained in canonical `artifact` documents as ordered
  64 KiB base64 chunks. A canonical `file` manifest holds `bytesHash` (SHA-256 of
  original bytes), total size, ordered chunk IDs/count/size, and derived record IDs.
  Each chunk has its own byte size/hash. Record `sources` refers to the manifest.
- A normalized source record is retained under `raw`; `provenance` records the
  format, filename, source line/record, normalized record SHA-256, original source-byte SHA-256, and location semantics.
- `normalizedHash` is SHA-256 of recursively key-sorted compact JSON. This is
  explicitly distinct from the retained original file bytes and their hash. The document
  ID is `wireless-import:` plus SHA-256 of dataset, format, and record hash joined
  by LF. Filename and import wall clock do not affect identity.
- WiGLE `Type=WIFI` maps to a wireless-network with validated BSSID, optional
  integer radio fields, and unknown security (authMode retains source text).
- Other WiGLE types and Kismet device records use canonical generic documents.
  No AP/station/person identity is inferred from names or device identifiers.
- Source timestamps stay raw; timezone-less WiGLE dates are not guessed as UTC.
  Coordinate text stays raw and is not promoted to a person's location.
- Unsafe JSON numeric values, including negative zero, fail closed through the
  canonical browser parser. The published SDK `481fa64750c3af29a273d725389c13e793109a64` still changed
  parsed -0/-0.0/-0e3 to 0 in a direct probe; the mutation path also uses
  JSON.stringify. Negative-zero import remains unsupported. This is an importer
  limitation, not a canonical schema restriction. Numeric values are never
  relabeled as strings.
- Identical observations in a submitted batch deduplicate; changed records have
  distinct IDs and preserve source history. Existing ID conflict policy applies
  on repeat imports. Any parse/schema error prevents default atomic import.

## Bounds and remaining work

This is a bounded preview adapter, not an unbounded streaming importer: 16 MiB
combined input, 10,000 total documents including custody artifacts, existing per-record/error limits. JSON arrays and
CSV are materialized within that bound. UTF-8 decoding is strict; BOM, original
headers, CRLF/newlines and whitespace are retained byte-for-byte in source
artifacts. Parsing normalization does not replace the retained evidence. Existing desktop staged commit and
restart tests remain responsible for Tek9 durability; adapter tests use a save
spy and do not prove native database durability.

Direct Kismet SQLite, WiGLE SQLite and KML ingestion, persistent checkpointed
source scanning, Android parity, and physical Android persistence are pending.
The UI states supported formats and export requirements explicitly.

## Source contracts inspected

- https://kismetwireless.net/docs/dev/kismetdb/ — device JSON in SQLite logs
- https://kismetwireless.net/docs/readme/kismetdb/kismetdb_device_json/ — official device export
- https://github.com/wiglenet/wigle-wifi-wardriving — WiGLE CSV export source

Tek9 upstream e6d1cb86a2e268a894eae3acae9617238b2adcff provides
`apply-ingest-batch` / `fetch-ingest-checkpoint`, with generation-fenced atomic
watermarks, but upgrading the pinned engine requires a separate compatibility
check. This slice retains Quasar's existing store transaction API.

## Verification in this workspace

Production adapter output (WiGLE + Kismet synthetic fixtures) passed the actual
`document.import.begin/chunk/commit` control-plane path into pinned Tek9/LMDB.
A separate SBCL process reopened that store and read back both records and four source custody artifacts, checking every original
field. Recovery verifies manifest count/order/size, each chunk hash, total byte
hash, and exact byte equality with original CSV/JSONL files. The test also checks
that all six documents are invisible before staged commit.
All eight existing Phase 2 storage specification cases also passed: direct get,
paging, durable stage ownership, stage restart, chunk replay, conflicting replay/
gaps, abort after restart, and compact journal.

Frontend: final full 441-test suite passed with maxWorkers=2/testTimeout=20000
(default parallel first run had seven schema initialization timeouts). TypeScript
and production Vite build passed. JSX is excluded by the repository ESLint configuration, so lint does not
establish JSX correctness.

Visual UI acceptance remains unverified: installed Chromium cannot create its
required local socket in this executor, including the approved escalated retry;
the supported cloud browser refuses localhost with ERR_BLOCKED_BY_CLIENT.
`e2e/wireless-imports.spec.ts` is supplied for a working authorized preview,
including selection, success/reload and validation-error screenshots. This
scenario has not run successfully here and is not evidence of visual acceptance.

Reproduce production adapter → native store → process restart proof with
`bash scripts/test-wireless-persistence` inside the configured Lisp/Node development
environment. `SBCL` can select an already-installed executable. Both write and
read stages must pass; a fixture-only pass is insufficient.

Source recovery tests reject missing/corrupted/reordered chunks and verify a
140 KiB multi-chunk source. Duplicate observations and source byte identities are
deduplicated independently; distinct header bytes keep distinct source manifests
even when their normalized record IDs match.
