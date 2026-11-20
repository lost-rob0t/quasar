%% Star-server / Forgejo integration relay knowledge.
%% Verified live 2026-11-19 against star-server (dev-bypass) and
%% git.starintel.actor; commits 13966be, ea35965, b77c763 on bug-squash.

%% --- CORS reality -------------------------------------------------------
%% Neither star-server nor the Forgejo API emit Access-Control-Allow-Origin,
%% so the React UI can never fetch them directly from any dev origin
%% ('Failed to fetch' before auth even matters). Every integration fetch is
%% relayed server-side through the control plane.

relay_command_pattern('control-plane/src/starintel-relay.lisp').
relay_commands(['starintel.probe', 'starintel.registry']).
relay_probe_contract('starintel.probe', '{url, token?}', '{mode, capabilities}', 'v1 capabilities endpoint first, legacy / fallback').
relay_registry_contract('starintel.registry', '{url?, token?}', 'JSONL rows', 'default URL is the Forgejo raw actors.jsonl').
relay_rule(new_star_server_integration_fetch_goes_through_relay).
relay_error_codes(['starintel.invalid-url', 'starintel.unreachable', 'registry.too-large', 'query.record-too-large']).

%% --- star-server facts --------------------------------------------------
star_server_auth_mode(dev_bypass,
    'any credential or none returns 200 administrator with admin scopes; token forwarding is wired for the future').
star_server_health_endpoint('http://127.0.0.1:5000/health').
star_server_search_endpoint('http://127.0.0.1:5000/search?q=...&limit=...',
    'couchdb-shaped response: total_rows, rows, bookmark cursor').
star_server_search_ui_gap('forgejo issue nsaspy/quasar #142: UI document.search only queries the local tek9 store; star-server /search is never called').

%% --- Forgejo actor registry --------------------------------------------
forgejo_registry_repo('starintel-labs/starintel-pro-actors').
forgejo_registry_branch('registry/actors').
forgejo_registry_file('registry/actors.jsonl').
forgejo_registry_emitter('scripts/emit_actor_registry.py regenerates from manifest_core.ACTOR_MANIFESTS; rerun whenever actor manifests change').
forgejo_registry_refresh_rule(commit_a_fresh_jsonl_after_manifest_changes).

%% --- Wiring gotchas (each one cost a live debugging round) --------------
wiring_gotcha(ws_allowlist,
    'new WS commands must be added to +standard-client-commands in control-plane/src/websocket-server.lisp or the client gets "Command X is not permitted"').
wiring_gotcha(ws_origin_allowlist,
    'the UI origin must be in *websocket-allowed-origins* (init file) or the WS handshake returns 403; moving the Vite port silently breaks the handshake').
wiring_gotcha(export_init_symbols,
    'init files run in quasar.config; referencing unexported package symbols (e.g. quasar.plugin:+development-origins+) is a read-time error - symbols must be exported').
wiring_gotcha(actor_manifest_source,
    'normalizeActorManifest requires non-empty source for browser actors; server-managed entries use runtime pro-actor-fleet and are exempt, and runActor blocks them from browser execution').

%% --- Purge & count invariant -------------------------------------------
purge_command('workspace.purge-documents',
    'settings danger-zone two-step; deletes the tek9 document prefix and reconciles meta documentCount to 0 in the same write transaction').
count_invariant('meta documentCount can silently diverge from prefix rows (live: 406 vs 45349); regression tests pin prefix==meta across purge in control-plane/tests/purge-documents-tests.lisp').

%% --- Bounded startup contract ------------------------------------------
startup_sync_contract('synchronize() fetches exactly ONE bounded snapshot page (512KiB) then publishes synchronized; full paged drains are explicit snapshot() callers (stats/export/refresh); oversized single documents fail bounded with query.record-too-large instead of exhausting the heap').
