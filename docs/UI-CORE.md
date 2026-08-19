# Quasar UI core

Quasar presents one investigation interface across three deployment modes:

```text
Quasar UI core
    |
    +-- standalone browser adapter
    +-- Common Lisp Quasar control-plane adapter
    +-- Auto-Dig embedded adapter
```

The UI core owns presentation: route identity, the application shell, navigation, status presentation, graph workspace chrome, responsive behavior, and reusable interaction components. Adapters describe deployment capabilities and health. They do not become alternate document or graph authorities.

## Invariants

- Every route uses the same global sidebar, brand, top bar, spacing, and navigation treatment.
- Exactly one primary navigation item is active at a time.
- Datasets is a first-class `/datasets` route. The old `/documents?group=dataset` entry point redirects to it.
- Graph-specific controls live inside the content workspace. Graph CSS does not rewrite the global application shell.
- Runtime/service failures are summarized by one status center. Individual actionable failures may still produce notices.
- The Common Lisp deployment remains authoritative for migrated durable operations. Auto-Dig embedding does not weaken that boundary.
- The standalone adapter may expose browser-local capabilities only when the standalone edition actually owns them.
- Mobile and desktop consume the same navigation model.

## Adapter contract

An adapter provides stable deployment metadata, capability flags, and a health projection over the current Quasar state. Presentation code consumes the adapter through `UiRuntimeProvider`.

The current adapters are:

- `control-plane`: normal `quasar` deployment backed by the Common Lisp control plane.
- `auto-dig`: embedded Quasar surface hosted by Auto-Dig while retaining the control-plane authority.
- `standalone`: browser-local `quasar-ui` deployment.

Adding another host should add an adapter rather than fork the shell.

## Styling

The `ui-core/` CSS layers are loaded last and form the authoritative shell/design-system layer:

- `shell.css`: global tokens, shell geometry, navigation, common controls, and page chrome.
- `surfaces.css`: status center and dataset presentation.
- `graph.css`: graph-workspace layout inside the shell.
- `responsive.css`: mobile, narrow desktop, and graph full-viewport behavior.

Legacy feature CSS remains responsible for feature internals while migration continues, but it may not change global shell geometry based on the active route. In particular the old graph fullscreen/workspace CSS is no longer loaded by the application entry point.

## Regression gates

Playwright verifies that major desktop routes retain identical shell geometry, exactly one navigation item is active, `/datasets` does not also select Documents, the graph remains inside the global shell, and mobile navigation uses the same route model.
