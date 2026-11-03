%% Durable Quasar testing knowledge.

pitfall(test_lisp_needs_nix, 'scripts/test-lisp CFFI-loads sqlite/lmdb: run it inside `nix develop -c bash scripts/test-lisp`; bare-shell runs die on libsqlite3.so.0/liblmdb.so and the script only self-adds openssl+lmdb from the default nix profile').
pitfall(melissa_stop_test_flake, 'tests/melissa-tests.lisp test-melissa-stop-fails-pending-request races a 1000ms delayed fake transport against bridge shutdown (ask-s timeouts 1-2s): fails under machine load independent of code changes; re-run on a quiet machine before blaming a diff').
pitfall(worktree_npm, 'fresh quasar worktrees need `npm ci` before `npm run check` (frontend prettier/eslint/tsc run from the workspace install)').
