# Native SQLite import boundary

Desktop production import support remains StarIntel JSON/JSONL/CSV, WiGLE CSV,
and Kismet device JSON/JSONL. The Android follow-up adds a bounded read-only
WiGLE SQLite preview; this does not add a desktop SQLite picker capability.

The desktop's existing CLOG dependency includes cl-sqlite, but that adapter's
public `connect` uses sqlite3_open and offers only a busy timeout. It does not
expose read-only open_v2, an authorizer, or query-progress cancellation. Quasar's
control plane also has no binary-source upload/preview command. Connecting an
arbitrary imported database through this API would not meet the read-only and
bounded execution contract. No browser WASM dependency or replacement store was
introduced.

A future desktop implementation needs an explicit bounded source-upload/session
contract, ordinary-table-only read-only SQLite API with cancellation, and app
capability discovery before claiming native SQLite support. Existing Tek9 staged
promotion should remain the atomic persistence boundary.

The standalone wireless persistence proof now also accepts `abort` and `empty`
modes and `QUASAR_IMPORT_TEST_REPLAY=1`. The sibling Android
`scripts/test-sqlite-native-tek9.sh` uses actual host SQLite fixture extraction
and the actual portable Java projection to test staged Tek9 chunk replay,
precommit invisibility, process-restart readback, original-byte reconstruction,
and abort followed by restart with no surviving documents. It does not prove
that desktop UI can open SQLite or that Android's native SQLite engine ran.
