%% Tooling and harness knowledge for the Quasar Lisp control plane.

test_command('nix develop -c scripts/test-lisp', 'full quasar-tests suite; nix devShell supplies openssl/sqlite/lmdb native libs').
harness_risk(cl_source_registry_local_projects,
             'a symlinked quasar checkout in ~/quicklisp/local-projects registers foreign quasar-* systems that override this repo even after explicit asdf:load-asd; scripts/test-lisp excludes local-projects for this reason').
fasl_cache('SBCL fasls live under ~/.cache/common-lisp/sbcl-<version>-linux-x64/<source-path>; nix develop uses a different SBCL version than the host, so caches differ').

known_flaky(test_melissa_stop_fails_pending_request,
            'races a 1000ms transport delay against bridge stop; FAIL prints without gating the suite exit').
known_preexisting_failure(test_pro_actor_manifest_discovery_and_target_gate,
            'validate-pro-actor-target returns (cons "authorized" t); the jsown round-trip parses true to T, the test expects :true; fails on pristine main under a correct registry').

known_flaky(test_tek9_restart_restores_canonical_workspace,
           'on the CPU-throttled Forgejo runner the document.create response string arrived truncated at ~10KiB and jsown:read-number subseq-overran (BOUNDING-INDICES-BAD-ERROR (10284 . 12868)); 3/3 clean runs locally under nix develop and the same suite passed in the later Forgejo validate run 68 - timing/pressure dependent, suspected response-buffer reuse race in the Tek9 response path, not yet root-caused').

%% --- Long-lived dev server launches (verified 2026-11-19) ---------------
process_rule(opencode_tool_shells_reap_process_groups_on_exit,
             'nohup & alone is NOT enough for long-lived servers; wrap in setsid bash -c \'...\' or the SBCL/Vite die when the tool shell exits').
process_rule(pure_nix_develop_scrubs_host_env,
             'env wiring (STAR_SERVER_URL, ports, tokens) never reaches SBCL under pure nix develop; use nix develop --impure --command when env must pass through').
process_rule(concurrent_sbcl_instances_need_isolated_asdf_caches,
             'parallel control planes clash on ~/.cache/common-lisp; give each XDG_CACHE_HOME=/tmp/opencode/cache-<lane>').
process_rule(vite_serves_unimported_css,
             'un-imported css files are still fetchable at /src/<file>.css, so grepping served assets misleads; layout-critical sheets must be in the main.tsx import list (the fullscreen no-op root cause)').

%% --- Daily port map on this host ----------------------------------------
port_owner(8080, 'SearXNG - do not bind quasar here').
port_owner(5173, 'historic quasar UI port; YaCy favicon cache confusion source').
port_owner(4781, 'current Vite UI (random port per operator preference)').
port_owner(8082, 'quasar control plane HTTP (CLOG host)').
port_owner(8081, 'quasar WebSocket').
port_owner(5000, 'live star-server ingest (dev-bypass auth)').
