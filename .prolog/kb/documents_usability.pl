% Documents workspace usability findings and fixes.
:- multifile usability_issue/3, usability_fix/2, usability_source/2.
usability_issue(documents_search_history, documents, back_button_traverses_query_keystrokes).
usability_issue(documents_empty_state, documents, empty_corpus_described_as_failed_filter).
usability_issue(documents_release_copy, documents, hardcoded_release_outlives_consumer_lock).
usability_issue(document_list_context, documents, detail_navigation_discards_list_filters).

usability_fix(documents_search_history, replace_query_url_entry).
usability_fix(documents_empty_state, distinguish_empty_corpus_from_filtered_results).
usability_fix(documents_release_copy, version_neutral_intro).
usability_fix(document_list_context, carry_list_location_through_detail_and_edit).
usability_source(documents_search_history, 'frontend/src/components/Documents.jsx').
usability_source(documents_empty_state, 'frontend/src/components/Documents.jsx').
usability_source(documents_release_copy, 'vendor/star-cl/schema/starintel-schema.lock.json').
usability_source(document_list_context, 'frontend/src/components/Documents.jsx').

%% Cascading right-click menus (2026-11-19, cf1c45d/5560099): components/
%% CascadingMenu.jsx renders root + one panel per path, bounded at
%% CASCADE_MAX_DEPTH=3; panels reset via React key on the menu (canvasMenu
%% kind+x+y), not internal effects. Items are
%% {label, Icon, onSelect, disabled, danger, children}. The
%% GraphObjectTypePickerBridge intercepts menuitem clicks labeled
%% "Other object type" inside ".graph-context-menu, .cascading-menu" and
%% closes the origin menu via a synthetic Escape. Documents table rows
%% (workspace + server) use the fixed-position mode with clientX/Y.
usability_fix(cascading_context_menus, components/CascadingMenu.jsx).
usability_source(cascading_context_menus, 'forgejo PR #147 (operator UI issue 4)').

%% Bounded graph fetch (fd175e5): lib/graph-fetch.js walkLocalGraph /
%% walkRemoteGraph are depth-capped (max 3) and budget-capped (default 200
%% docs, max 5 cursor pages per node). Remote walks page starintel.neighbors
%% per node then fetch each new neighbor via starintel.document;
%% canonicalRemoteGraph synthesizes relation documents from neighbor tuples
%% keeping the SERVER's stable relation ids so refetches stay idempotent.
%% Surfaces: node cascade "Fetch graph > Neighbors/Whole graph" and
%% Documents server rows "Fetch from server".
usability_fix(bounded_graph_fetch, lib/graph-fetch.js).
usability_source(bounded_graph_fetch, 'forgejo PR #147 (operator UI issue 5)').

%% Multi-server model (0f7307b): settings.servers is a saved list
%% [{name,url,token}]; the ACTIVE server remains settings.serverUrl/
%% serverToken so documents recents/search, stats probe, actor discovery,
%% and graph fetch all follow one switch. documentsRouteCache is
%% workspace-bound (local document.search pages) - server switches need NO
%% cache invalidation; the live chain resets via its serverUrl dependency.
%% Deferred: querying MULTIPLE servers simultaneously (aggregation).
usability_fix(multi_server_active_switch, components/ImportSettings.jsx).
usability_source(multi_server_active_switch, 'forgejo PR #147 (operator UI issue 6)').
