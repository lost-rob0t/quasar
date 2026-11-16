%% Forgejo Actions vs GitHub Actions portability for quasar CI.

%% The repo runs CI on both GitHub (lost-rob0t/quasar, authoritative merges)
%% and Forgejo (git.starintel.actor/nsaspy/quasar, canonical remote). Workflow
%% files live in .github/workflows and must stay valid on both.

ci_host(github, 'lost-rob0t/quasar', 'authoritative: PRs are merged here; main push runs ci.yml').
ci_host(forgejo, 'nsaspy/quasar', 'canonical remote; Actions runs as a mirror of the same workflows').

%% Forgejo rewrites shorthand `uses:` to the data.forgejo.org action mirror.
%% The mirror only carries select actions; anything else fails the job during
%% workflow preparation, before checkout, with "fatal: repository ... not found".
action_mirror_missed('actions/github-script@v7',
    'not on data.forgejo.org; replaced 2026-11-16 with plain curl+jq REST (ci.yml Publish PR visual evidence)').
action_mirror_missed('DeterminateSystems/nix-installer-action@v22',
    'not on data.forgejo.org; replaced 2026-11-16 with the official install.determinate.systems script and --init systemd/none autodetection').

%% upload-artifact@v4 clones from the mirror but hard-fails at runtime on
%% Forgejo: the server does not implement the artifact v2 API, so the action
%% errors with GHESNotSupportedError. Job dies even though every real step passed.
artifact_api_unsupported(forgejo, 'actions/upload-artifact@v4',
    'GHESNotSupportedError at upload; every upload step carries continue-on-error: true since 2026-11-16').

%% Portable-workflow invariants for future edits.
ci_invariant(shorthand_uses_must_be_mirrored,
    'every shorthand uses: must exist on data.forgejo.org (actions/checkout, actions/setup-node, actions/upload-artifact are verified present)').
ci_invariant(no_github_script,
    'do not reintroduce actions/github-script; post/patch PR comments with curl against github.api_url using GET/DELETE/POST routes, which are identical on GitHub and Forgejo (PATCH route differs: GitHub /issues/:n/comments/:id, Forgejo /issues/comments/:id)').
ci_invariant(nix_install_must_autodetect_init,
    'nix install must discriminate GitHub runners from Forgejo act containers by /run/systemd/system existence (systemd as PID 1), never by systemctl is-system-running: GitHub images often report degraded (exit 1), which wrongly selects --init none under sudo and leaves the daemon unstarted (nix build: big-lock Permission denied). The installer also needs --no-confirm in CI.QUASAR_SYSTEMD_RUNTIME_DIR overrides the path for local tests').
ci_invariant(ci_guard_tracks_workflow_content,
    'scripts/check-control-plane-deps.mjs (npm run check) asserts literal strings in ci.yml, including the Nix install source; it previously pinned DeterminateSystems/nix-installer-action@v22 and failed the validate job when the install method changed. Update the guard in the same commit as any workflow restructuring').
ci_invariant(evidence_comment_degrades_without_artifacts,
    'on Forgejo the artifact-url step output is empty (upload tolerated-failed); the PR visual evidence comment then reports incomplete coverage instead of failing').

%% Slow-box ceilings (2026-11-16, run 68 evidence): the Forgejo act runner is
%% ~10x slower than GitHub runners; 462+84 vitest passed with the 60s ceiling
%% and Playwright only failed on per-test timeouts (page.goto could not finish
%% "load" in 30s under chromium/vite/CLOG contention).
ci_invariant(slow_runner_timeouts_are_ceilings,
    'frontend/playwright.config.ts carries timeout 120s + expect timeout 20s and ci.yml validate timeout-minutes 90 purely as ceilings for the throttled Forgejo box; fast runners finish far sooner and genuine hangs still fail - do not lower them for local convenience').

%% E2E capacity boundary (2026-11-16, runs 72/73/74): three attempts with the
%% raised ceilings still exceeded a 90-minute budget on the Forgejo box while
%% GitHub finishes the identical suite in ~6 minutes. The e2e step, playwright
%% browser install, screenshot gate, artifact uploads, and PR evidence comment
%% are therefore gated to github.server_url; Forgejo validate covers checks,
%% vitest unit+integration, the Lisp suite, and the real-stack smoke, all of
%% which it passes (runs 68/73).
ci_invariant(e2e_chain_is_github_only,
    'the Playwright e2e step and every step consuming its outputs carry the github.server_url gate; do not ungate them without first proving the Forgejo runner can finish the suite solo within its budget').
