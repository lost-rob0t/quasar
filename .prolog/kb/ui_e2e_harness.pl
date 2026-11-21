%% UI e2e harness: running operator-journey tests against the live stack,
%% and the interaction contracts they encode.
:- multifile harness_fact/2, ui_contract/2, ui_bug_pattern/3.

%% The Playwright suite (frontend/e2e) is the durable home of operator
%% journeys. Config defaults target a CI-spawned stack (vite :5173, CP
%% :8080/:8081); against the operator's live desktop stack, override the
%% ports and Playwright REUSES the running servers instead of spawning:
harness_fact(run_live,
    'cd $QUASAR_CHECKOUT && QUASAR_VITE_PORT=4781 QUASAR_HTTP_PORT=8082 \
     QUASAR_WS_PORT=8081 npm run test:e2e -- e2e/<spec>.spec.ts').
%% webServer.reuseExistingServer is enabled when CI is unset.

%% 2026-11-20: the e2e chain is gated to GitHub (75e34f3); Forgejo's validate
%% job never ran it, so the cascade-menu rewrite (PR #147) shipped with a
%% stale spec AND a live bug no gate caught. Any change to menus/dialogs must
%% run the graph e2e family locally against the live stack before merging.
harness_fact(forgejo_e2e_dark,
    'Forgejo CI does not run playwright; run the affected e2e specs locally against the live stack before merging UI work').

%% Stage-level close-guards that clear menu state on pointerdown MUST exempt
%% the menu root(s) in their closest() selector. pointerdown precedes click:
%% an unexempted guard unmounts the menu before any menuitem click can act.
ui_contract(menu_close_guard,
    'closeCanvasMenu-style handlers exempt ".graph-context-menu, .cascading-menu" (GraphPage.jsx closeCanvasMenu)').

%% Escape semantics for cascades belong to CascadingMenu alone (back out of
%% a submenu, then close via onClose). Blanket window keydown handlers that
%% setCanvasMenu(null) on Escape defeat submenu back-out - do not add them.
ui_contract(cascade_owns_escape,
    'CascadingMenu.jsx owns Escape (back-out then close); no blanket window Escape handlers for menu state elsewhere').

%% Playwright actionability retries fight canvas drag/select handlers that
%% mutate the stage during the click sequence; use page.mouse.click for
%% presses on graph canvas regions.
ui_contract(canvas_press_raw_mouse,
    'use page.mouse.click for presses on the graph canvas; locator.click stability-retries race selection handlers').

%% Live-data journeys (documents recents) must skip cleanly, not fail, when
%% the stack or the couchdb view index cannot serve data (deploys reset view
%% indexes; totals read 0 mid-rebuild).
ui_contract(live_data_skips,
    'documents-recents.spec.ts skips when star-server /health fails or /documents/recent total_rows=0 (index mid-rebuild)').

%% Renaming a component class without updating every guard/bridge selector
%% that matches it. 2026-11-20: flat menu class .graph-context-menu survived
%% in closeCanvasMenu after the cascade (.cascading-menu) rewrite.
ui_bug_pattern(class_rename_guard_drift,
    '.graph-context-menu -> .cascading-menu',
    'grep BOTH old and new class names across src/ when renaming menu/container classes; guards, bridges, enhancers all match on them').
