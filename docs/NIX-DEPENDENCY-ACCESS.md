# Pinned runtime dependency access

The required `Fresh Nix runtime + real startup` job builds the actual saved
runtime and authentication bridge. Do not bypass this job when validating the
bounded-read/client integration.

`starintel-biz` remains pinned to Forgejo commit
`c25f9e8972c2392c9c43f30c2254654012d26d38`, NAR hash
`sha256-DjtUjmaoyuO6H60N8J3Y2g/r6m3HYpR2Ppij5g1qwEo=`. The source supplies
`quasar-auth` and `quasar-auth-host`; it is not an optional test fixture.

Investigation on 2026-10-17:

- Hosted combined run 38983047636, job 117248099648, failed fetching the
  Forgejo URL with HTTP 502 before runtime build/smoke.
- A fresh fetch from the official `starintel-labs/starintel-biz` GitHub
  repository has the exact pinned commit and tree
  `1f16fc302fe044c405c8bf7b886c8f4be81388b3`.
- `git archive` of that commit followed by actual `nix hash path` produced the
  existing NAR hash above, verifying identical content.
- Authorized GitHub repository metadata reports that mirror as private.
  Tracked workflows use default `actions/checkout@v4` for Quasar and configure
  no cross-repository token, Nix access-token, netrc, or dependency checkout.
  The local authenticated fetch does not establish fresh CI access.

The minimum source-access repair is for the owner to restore the existing
Forgejo endpoint for the unchanged pinned commit. Alternatively, the owner must
explicitly provision CI read-only access to the existing private mirror before
an integration-only URL change can be tested with the same revision/hash.
No credential values have been copied or created; no private repository has
been published. No input pin, authentication code, or required gate was changed.
This access issue is separate from client/catalog source defects.

The local disposable Nix-container attempt used the existing host trusted CA
bundle read-only, keeping TLS verification enabled. Certificate validation then
succeeded, but proxy CONNECT 403 blocked `cache.nixos.org` and
`ftpmirror.gnu.org/bash/bash-5.3.tar.gz`; `nix develop --command true` failed.
This is not a Nix-runtime or Lisp test pass. Supplemental host frontend tests
must remain labeled separately from required Nix and real-stack checks.
