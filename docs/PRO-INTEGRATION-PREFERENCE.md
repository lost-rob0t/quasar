# Pro integration display preference

Settings → Pro integration offers `proIntegrationMode`: `off`, `auto` (default),
or `on`. Save settings to apply. It is persisted in the existing local PouchDB
`quasar-ui-state-v1` settings document, and travels through the existing safe
settings export/import. Missing or invalid values normalize to `auto`.

- **Off:** hide the Pro actors panel and skip its capability/manifest discovery.
  It does not unload host plugins, revoke capabilities or cancel a subscription.
- **Auto:** show the panel only while connected, after the session advertises
  both `pro-actors.manifests` and `pro-actors.submit-target` and manifest discovery
  succeeds. A supported empty catalog shows the existing empty-catalog message.
- **On:** always show the panel, including offline, unavailable and error states.
  Discovery and submission still require the same grants as Auto.

## Authority and optional plugins

`quasar.app:start` installs the Pro actor command handlers even without a billing
plugin. Registration is therefore not evidence of a paid plan. The WebSocket
`system.capabilities` response is the authenticated session's grant list, not the
unfiltered command registry. The trusted host/plugin chooses those grants;
`quasar.ws` checks them before dispatch. `pro-actors.submit-target` also validates
the canonical manifest before the browser submits to StarIntel's server.

There is no browser API for identifying an installed billing plugin or reading a
subscription's active/inactive status. Auto uses the supported runtime contract:
current grants plus successful discovery. It never infers payment from a local
manifest, a setting, a plugin name, or an empty catalog. Missing grants mean
unavailable, not proof that a subscription is inactive. Discovery failure means
unknown/unavailable, not an expired subscription. User-supplied `init.lisp` and
its general-purpose policy hooks remain untouched; no plugin becomes mandatory.

Disconnect, refresh and changed connection state discard previous availability.
Late discovery replies cannot restore a hidden panel. Switching Off prevents a
pending capability check from starting manifest discovery. Requests already sent
cannot be undone. After target authorization returns, the component rechecks the
current preference/connection before submitting; server authorization is still
required and remains the security boundary.

## Scope and coordination

This is the shared Quasar web UI, not an Android/native subscription change.
Read-only inspection of the available `starintel-wearos` Kotlin sources found no
corresponding Pro subscription UI; that repository was not edited.

Open issue/PR searches found no existing Off/Auto/On implementation. Related
#58 owns the trusted plugin policy architecture. Reviewed changed-file ownership
for #110 and #115–#120: this patch does not touch their actor workflow, provider,
client synchronization, storage, mutation, graph or pagination files. Keep those
PRs independent. The existing manifest handler's workspace read is unchanged;
this preference does not claim to solve bounded manifest discovery.

## Verification

Tests cover unknown/missing/partial grants, supported access, absent integration,
offline/errors, Off/Auto/On rendering, delayed discovery and persistence. The
Chromium journey mounts the real settings and Pro components against synthetic
host replies and uses real PouchDB. It does not exercise a live billing plugin.
The focused browser journey can also run without a Lisp server:
`nix develop --command bash -c 'cd frontend && npx playwright test --config playwright.pro-integration.config.ts'`.
Set `QUASAR_CHROMIUM_EXECUTABLE_PATH` only to use an installed Chromium instead
of Playwright's managed browser.

Run the normal repository checks through `nix develop --command ...` as required
by AGENTS.md. The authoring environment lacks Nix; supplemental host results and
remaining gates are recorded in the draft PR.
