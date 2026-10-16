import { expect, test } from "@playwright/test";

test("Pro preference persists and gates the real panel with current host grants", async ({
  page
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const source = await (await page.request.get("/src/components/ProActorManager.jsx")).text();
  const reactUrl = source.match(/from "([^"\n]*deps\/react\.js[^"\n]*)"/)![1];
  const mainSource = await (await page.request.get("/src/app/main.tsx")).text();
  const domUrl = mainSource.match(/from "([^"\n]*deps\/react-dom_client\.js[^"\n]*)"/)![1];
  await page.route("**/src/store.jsx", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `import React from '${reactUrl}';
      export function useQuasar() { return React.useContext(window.proContext); }`
    })
  );
  await page.route("**/src/control-plane/mutations.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `export async function cpSystemCapabilities() {
      window.proCalls++; if (window.proFailure) throw new Error('offline');
      return window.proGrants;
    }
    export async function cpProActorManifests() {
      window.proManifestCalls++;
      if (window.proMissing) throw new Error('protocol.unknown-command');
      if (window.proDelayed) await new Promise(resolve => window.proRelease = resolve);
      return [];
    }
    export async function cpAuthorizeProActorTarget() { throw new Error('security.forbidden'); }`
    })
  );
  await page.route(
    (url) => url.pathname === "/",
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><body><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    </script></body></html>`
      })
  );
  await page.goto("/");
  await page.evaluate(
    async ({ reactUrl, domUrl }) => {
      // Mount production components with a synthetic host; no backend/billing changes.
      const reactPath = reactUrl;
      const domPath = domUrl;
      const panelPath = "/src/components/ProActorManager.jsx";
      const settingsPath = "/src/components/ImportSettings.jsx";
      const dbPath = "/src/lib/db.js";
      const { default: React } = await import(/* @vite-ignore */ reactPath);
      const {
        default: { createRoot }
      } = await import(/* @vite-ignore */ domPath);
      const { default: Panel } = await import(/* @vite-ignore */ panelPath);
      const { SettingsPage } = await import(/* @vite-ignore */ settingsPath);
      const db = await import(/* @vite-ignore */ dbPath);
      const initialSettings = await db.getSettings();
      const w = window as any;
      w.proCalls = 0;
      w.proManifestCalls = 0;
      w.proGrants = [];
      w.proContext = React.createContext(null);
      function Harness() {
        const [settings, setSettings] = React.useState(initialSettings);
        const [status, setStatus] = React.useState({ connected: true });
        w.proConnection = (connected: boolean) => setStatus({ connected });

        const context = {
          documents: [],
          selectedDocuments: [],
          settings,
          controlPlaneStatus: status,
          persistSettings: async (next: object) => {
            await db.saveSettings(next);
            setSettings(await db.getSettings());
            w.proSaved = (next as any).proIntegrationMode;
          },
          databaseInfo: async () => ({ documents: {}, state: {} }),
          syncStatus: {},
          serverStatus: {},
          queueStatus: {},
          setNotice: (notice: unknown) => {
            w.proNotice = notice;
          }
        };
        return React.createElement(
          w.proContext.Provider,
          { value: context },
          React.createElement(SettingsPage),
          React.createElement(Panel)
        );
      }
      const container = document.createElement("div");
      document.body.replaceChildren(container);
      createRoot(container).render(React.createElement(Harness));
    },
    { reactUrl, domUrl }
  );
  const mode = page.getByLabel("Pro integration mode");
  const save = page.getByRole("button", { name: "Save settings", exact: true });
  const panel = page.locator(".pro-actor-manager");
  await expect(mode).toHaveValue("auto");
  await expect(panel).toHaveCount(0); // No plugin/no grants: no upsell.
  await mode.selectOption("on");
  await save.click();
  await expect.poll(() => page.evaluate(() => (window as any).proSaved)).toBe("on");
  await expect(panel).toContainText("Pro integration unavailable");
  await expect(panel.getByRole("button", { name: /^Run / })).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.proGrants = ["pro-actors.manifests", "pro-actors.submit-target"];
    w.proConnection(true);
  });
  await expect(panel).toContainText("No pro-actor manifests yet");
  await mode.selectOption("auto");
  await save.click();
  await expect.poll(() => page.evaluate(() => (window as any).proSaved)).toBe("auto");
  await expect(panel).toContainText("No pro-actor manifests yet");
  // The preference survives a fresh read from the actual PouchDB settings store.
  expect(
    await page.evaluate(async () => {
      const path = "/src/lib/db.js";
      return (await (await import(/* @vite-ignore */ path)).getSettings()).proIntegrationMode;
    })
  ).toBe("auto");
  await page.evaluate(() => (window as any).proConnection(false));
  await expect(panel).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.proMissing = true;
    w.proConnection(true);
  });
  await expect(panel).toHaveCount(0); // Grants alone do not establish installed support.
  await mode.selectOption("on");
  await save.click();
  await expect.poll(() => page.evaluate(() => (window as any).proSaved)).toBe("on");
  await expect(panel).toContainText("protocol.unknown-command");
  await page.evaluate(() => {
    const w = window as any;
    w.proMissing = false;
    w.proFailure = true;
    w.proConnection(true);
  });
  await expect(panel).toContainText("offline");
  await page.evaluate(() => {
    const w = window as any;
    w.proFailure = false;
    w.proDelayed = true;
    w.proConnection(true);
  });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).proRelease))).toBe(true);
  await mode.selectOption("off");
  await save.click();
  await expect.poll(() => page.evaluate(() => (window as any).proSaved)).toBe("off");
  await page.evaluate(() => (window as any).proRelease());
  await expect(panel).toHaveCount(0); // Late response cannot resurrect the UI.
  const calls = await page.evaluate(() => (window as any).proCalls);
  await page.evaluate(() => (window as any).proConnection(true));
  expect(await page.evaluate(() => (window as any).proCalls)).toBe(calls);
  await page.reload();
  expect(
    await page.evaluate(async () => {
      const path = "/src/lib/db.js";
      return (await (await import(/* @vite-ignore */ path)).getSettings()).proIntegrationMode;
    })
  ).toBe("off");
  expect(browserErrors).toEqual([]);
});
