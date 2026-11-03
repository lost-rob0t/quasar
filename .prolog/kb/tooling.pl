%% Tooling and harness knowledge for the Quasar Lisp control plane.

test_command('nix develop -c scripts/test-lisp', 'full quasar-tests suite; nix devShell supplies openssl/sqlite/lmdb native libs').
harness_risk(cl_source_registry_local_projects,
             'a symlinked quasar checkout in ~/quicklisp/local-projects registers foreign quasar-* systems that override this repo even after explicit asdf:load-asd; scripts/test-lisp excludes local-projects for this reason').
fasl_cache('SBCL fasls live under ~/.cache/common-lisp/sbcl-<version>-linux-x64/<source-path>; nix develop uses a different SBCL version than the host, so caches differ').

known_flaky(test_melissa_stop_fails_pending_request,
            'races a 1000ms transport delay against bridge stop; FAIL prints without gating the suite exit').
known_preexisting_failure(test_pro_actor_manifest_discovery_and_target_gate,
            'validate-pro-actor-target returns (cons "authorized" t); the jsown round-trip parses true to T, the test expects :true; fails on pristine main under a correct registry').
