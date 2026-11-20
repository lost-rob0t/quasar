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
    'couchdb-shaped response: total_rows, rows, bookmark cursor; NO {status,data} envelope').
star_server_search_ui_gap('RESOLVED 2026-11-19 (forgejo #142): starintel.api relay op table + Documents Live ingest source filter; UI reaches every star-server fetch/view endpoint through one bounded WS command').

%% --- starintel.api relay (implemented 2026-11-19, issue #142) -----------
relay_read_ops(['search', 'stats', 'actors', 'document', 'neighbors', 'targets', 'view', 'dataset-size'],
    'one command starintel.api {url, token?, op, ...params, byteLimit?}; allowlisted params only; bounded via bounded-wire-result; write routes deliberately absent').
relay_neighbors_contract('starintel.api {op: neighbors, id}',
    'returns {id, document, total_relations, bookmark?, relations[]} where each relation carries {id, predicate, direction subject|object, neighbor, neighbor_dtype}; relations come from FTS on the exact quoted id; paged via bookmark').
relay_endpoint_shapes('gserver wraps /api/v1/capabilities and /api/v1/stats payloads in {status, data}; couchdb /search and views are envelope-free (total_rows top-level)').
relay_relation_endpoints('relation docs store subject/object as nested {id, dtype} objects on live star-server; %endpoint-id accepts bare ids too').
relay_param_rules('empty-string params are dropped; limit clamped (search 100, view 200, neighbors default 25); view names from a closed table; path segments are quri:url-encoded').
relay_ui_wiring('Documents: ONE merged table — workspace page first, server-only matches under an "On the server" divider (deduped against the corpus + saved set), first server page follows the query automatically, "Load more from server" pages the bookmark; row titles are clickable (local -> /documents/:id, server -> viewer); row actions: local = add-to-graph + delete, server = save-to-workspace + save-and-add-to-graph; the viewer header carries the same save/add buttons; Graph "Add corpus documents" picker lists server matches under a divider and saves local copies on submit').
relay_save_contract('save server doc = toCanonicalDocument(raw, {allowLegacy090, preserveUnmapped}) -> executeBatch([canonical], {replace: true}); the corpus event refresh swaps the live-only row for the local one').
relay_migration_lessons('migrateLegacy090Document preservesUnmapped stashes unknown data/envelope fields in extensions.quasarLegacy090 (default stays strict); legacy source objects {source_id, kind, name, accessed_at} convert to StarReference {schema, id} with metadata bagged; external_ids arrays pass through for array-native targets (payloadExternalIds) and become scheme-keyed objects for object-native targets (Document.externalIds); person external_ids still requires the identifier bundle').
relay_dataset_picker('Documents dataset filter is a type-ahead combobox (DatasetCombobox) with free-text create: the local bootstrap catalog does not know every server dataset, so typed names commit as filters even when "No matching datasets"').
relay_badge_semantics('server badge: yellow only while probing, green when reachable, red on failure; the store auto-probes the configured endpoint once per url|token on boot so the badge is truthful without opening Settings').
relay_filter_limitation('dtype/dataset URL filters apply to the WORKSPACE search server-side (tek9 %document-matches-scope-p); the server FTS has no dtype/dataset params, so SERVER rows in the merged view are POST-FILTERED client-side (liveOnlyRows in Documents.jsx, #143 fallback); server pagination continues from the unfiltered server chain').

%% --- Forgejo actor registry --------------------------------------------
forgejo_registry_repo('starintel-labs/starintel-pro-actors').
forgejo_registry_branch('registry/actors').
forgejo_registry_file('registry/actors.jsonl').
forgejo_registry_emitter('scripts/emit_actor_registry.py regenerates from manifest_core.ACTOR_MANIFESTS; rerun whenever actor manifests change').
forgejo_registry_refresh_rule(commit_a_fresh_jsonl_after_manifest_changes).
fleet_actor_execution('OPERATOR DECISION 2026-11-19: the pro-actor fleet is retired. Registry actors (runtime=pro-actor-fleet, id pro-actor:<actor_id>) run LOCALLY: store runActor routes them to control-plane pythonActorsRun {actor: actor.id, target: required free-text}; the lisp side runs the actor CLI from the checkout (QUASAR_PRO_ACTORS_PATH or ~/starintel/starintel-pro-actors) and creates a target:python-actors:<actor>:<slug> document. Browser-actor gates (actorsEnabled, e2e verification, graph selection) do NOT apply to fleet actors. ActorManager shows a target input next to Run and banner "Local registry actor"; actorKind is "local - python". Verified live: run round-trips and surfaces typed errors (python-actors.not-configured | .failed); fec fails on missing FEC_API_KEY, which is actor-side.').

%% --- Documents route pagination -----------------------------------------
route_cache_invariant('route-query-cache pages are a contiguous chain of DISTINCT scopes: all getPage callers queue behind SearchQueryEntry.inflight and fillTowardTarget assigns pageNumber from the serialized chain (pages.size + 1); without the lock, overlapping React effects stored the same page-1 scope twice (phantom page 2, doubled totals, operator-visible as "1-2 of 4" + pages 1|2 with only 2 real docs). getPage is deliberately straight-line - see the vite8_oxc gotcha. Diagnose counts with the WS probe BEFORE blaming the store: document.search returns {documents, complete, cursor} and the tek9 scan is honest.').

%% --- Wiring gotchas (each one cost a live debugging round) --------------
wiring_gotcha(vite8_oxc_transform_hang,
    'vite 8 (rolldown/oxc) can hang the module transform INDEFINITELY when an async closure in a module loops (for(;;)/while(true)/condition-while) or self-recurses - vitest prints the RUN banner and then produces nothing (0 CPU, no test output), while node imports and runs the same file perfectly. Symptom triage: a single test file hangs while other files pass. Fix: keep the closure straight-line and isolate the loop in a separate helper function (see route-query-cache.js getPage/fillTowardTarget); comment the constraint at the site so nobody reintroduces it').
wiring_gotcha(ws_port_plain_http,
    'NEVER probe the WS port (:8081) with plain HTTP - before the websocket-upgrade-request-p guard (websocket-server.lisp) wsd signaled "No Sec-WebSocket-Version header" and under --disable-debugger that quit the whole control plane. The guard now answers 400, but keep health checks on :8082. Related: pgrep -f run-control-plane + kill only kills bash wrappers - the sbcl child keeps ports 8081/8082, so a relaunch dies on USOCKET:ADDRESS-IN-USE-ERROR while the OLD server keeps answering; kill by port/process, then relaunch. A watchdog (/tmp/opencode/quasar-watchdog.sh) keeps the stack supervised and restarts the CP if HTTP :8082 dies.').
wiring_gotcha(ws_allowlist,
    'new WS commands must be added to +default-capabilities in control-plane/src/websocket-server.lisp or the client gets "Command X is not permitted"').
wiring_gotcha(ws_origin_allowlist,
    'the UI origin must be in *websocket-allowed-origins* (init file) or the WS handshake returns 403; moving the Vite port silently breaks the handshake').
wiring_gotcha(export_init_symbols,
    'init files run in quasar.config; referencing unexported package symbols (e.g. quasar.plugin:+development-origins+) is a read-time error - symbols must be exported').
wiring_gotcha(actor_manifest_source,
    'normalizeActorManifest requires non-empty source for browser actors. OPERATOR CORRECTION 2026-11-19: the starintel-pro-actors fleet is RETIRED; the old runtime=pro-actor-fleet "server-managed, not runnable in browser" classification is now a BUG - any actor quasar sees must be runnable either as a local actor or a browser actor. Registry manifests marked runtime=pro-actor-fleet currently get blocked from execution; trace and fix the gating (actors-core.js actorExecutionBlocked / E2E_VERIFIED_ACTOR_IDS, normalizeActorManifest runtime classification, store runActor gate)').

%% --- Purge & count invariant -------------------------------------------
purge_command('workspace.purge-documents',
    'settings danger-zone two-step; deletes the tek9 document prefix and reconciles meta documentCount to 0 in the same write transaction').
count_invariant('meta documentCount can silently diverge from prefix rows (live: 406 vs 45349); regression tests pin prefix==meta across purge in control-plane/tests/purge-documents-tests.lisp').

%% --- Bounded startup contract ------------------------------------------
startup_sync_contract('synchronize() fetches exactly ONE bounded snapshot page (512KiB) then publishes synchronized; full paged drains are explicit snapshot() callers (stats/export/refresh); oversized single documents fail bounded with query.record-too-large instead of exhausting the heap').

%% Bundled MCP server (6a3a8c9): mcp/starintel-mcp-server.mjs serves
%% streamable-HTTP MCP on 127.0.0.1:8083/mcp, proxies JSON-RPC tools to CP
%% WebSocket commands (envelope protocol MUST be the string
%% "quasar.control.v1"; document.search takes datasets[]/limit, NOT
%% page/perPage). Co-started by scripts/run-control-plane; the operator's
%% MCP clients (agent system mcp tab, external agents) attach via HTTP.
mcp_server_contract("quasar-mcp",
    tools([starintel_search, starintel_stats, starintel_recent_documents,
           starintel_document, starintel_neighbors, starintel_targets,
           starintel_dataset_size, workspace_search]),
    endpoint("http://127.0.0.1:8083/mcp"),
    transport(cp_websocket_ws_8081)).
