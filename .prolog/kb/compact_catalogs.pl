%%% Compact catalog knowledge verified in this branch
%%% (feat/bounded-workbench-catalogs, phase 2 backend).

catalog_record(dataset, 'catalog/dataset/<len:name>',
               '{name, documentCount, dtypes{name:count}, lastWriteAt}').
catalog_record(graph, 'catalog/graph/<len:gid>',
               '{id, name, nodeCount, edgeCount, updatedAt}').
catalog_marker('catalog', version(1), 'one write txn, idempotent double-check').

catalog_maintenance(commit_hook, '%apply-change per persistence-change kind').
catalog_maintenance(exact_deltas,
                    'fetch-previous-then-apply: dataset moves adjust both rows; node/edge deltas only on first upsert or delete').
catalog_maintenance(save_workspace,
                    'change hooks rebuild rows from clean prefix, then the marker is written').
catalog_migration(lazy_bootstrap,
                  'first bootstrap of a marker-less workspace builds rows in one write transaction; never a steady-state read path').
catalog_membership('graph.membership',
                   'pages node sidecar keys (bounded-node-scan), never decodes graph metadata rows or Tek9 topology').

%% Gotchas verified by tests and e2e.
catalog_gotcha(jsown_alist,
               'JSOWN objects are alists of (key . value); REMF on (rest obj) signals odd-length. Use REMOVE with key car instead.').
catalog_gotcha(length_prefixed_order,
               'Catalog keys are length-prefixed: 4:beta sorts before 5:alpha. Assertions and UI sorting must not assume lexical name order.').
catalog_gotcha(default_graph,
               'Every workspace carries the all-documents graph from creation; bootstrap graph pages are never empty for a used workspace.').
catalog_gotcha(smoke_contract,
               'scripts/smoke-startup.mjs accepts compact catalog pages in bootstrap but rejects documents/nodes/edges/documentIds rows; a rejected handshake causes terminate+retry storms that surface as SBCL corruption warnings.').
catalog_gotcha(e2e_browser_ws,
               'The browser client hardcodes ws://host:8081 unless VITE_CONTROL_PLANE_URL is set, and the WS origin check needs the websocket allowed-origins init var to include the vite port origin; custom-port e2e requires both.').
