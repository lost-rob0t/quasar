# Quasar engineering

- Run development, Lisp tests, browser checks, and benchmarks through the repository
  Nix shell: `nix develop --command <command>`. The shell supplies native libraries
  and defaults `QUASAR_TEK9_PATH` to the immutable Tek9 flake input. Override it
  explicitly only when testing a different Tek9 checkout.
- The current checkout's `systems/` and `vendor/star-cl/` must precede Quicklisp
  local projects in ASDF discovery. Launchers assert the selected Quasar source
  directory. A successful test against another checkout is not evidence.
- Resolve StarIntel authority using `vendor/star-cl/schema/starintel-schema.lock.json`
  and its repository-owned `vendor/star-cl/bin/sync-starintel-schema.py` checker.
- Tek9 owns canonical storage. Use exported Tek9 APIs, retain `:full` durability,
  and preserve the existing document/revision/journal/graph contract.
- For bounded reads, use `workspace.bootstrap`, `document.search`, and
  `document.batch`. Never drain search pages into a corpus array.
- `docs/BOUNDED-WORKBENCH.md` tracks the migration boundary. Legacy UI hydration
  and ordinary workspace cloning remain active until their dependent phases land.
- Verify bounded reads with `npm run test:lisp`; the suite includes real 10k/100k
  allocation gates and instrumentation that rejects eager reads. Reproduce detailed
  baselines with `bash scripts/benchmark-bounded-reads` inside Nix. Serialize Lisp
  checks that share an ASDF output cache.
