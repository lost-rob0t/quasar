import { expect, test, type Page } from "@playwright/test";

async function mountProHarness(page: Page, routed = false) {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const source = await (await page.request.get("/src/components/ProActorManager.jsx")).text();
  const reactUrl = source.match(/from "([^"\n]*deps\/react\.js[^"\n]*)"/)![1];
  const mainSource = await (await page.request.get("/src/app/main.tsx")).text();
  const domUrl = mainSource.match(/from "([^"\n]*deps\/react-dom_client\.js[^"\n]*)"/)![1];
  const routerUrl = mainSource.match(/from "([^"\n]*deps\/react-router-dom\.js[^"\n]*)"/)![1];
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
      return window.proManifests || [];
    }
    export async function cpAuthorizeProActorTarget() {
      window.proAuthorizationStarted = true;
      await new Promise(resolve => window.proAuthorizeRelease = resolve);
      if (window.proDeny) throw new Error('security.forbidden');
      return { authorized: true };
    }`
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
    async ({ reactUrl, domUrl, routerUrl, routed }) => {
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
      const Router = await import(/* @vite-ignore */ routerUrl);
      const db = await import(/* @vite-ignore */ dbPath);
      const initialSettings = await db.getSettings();
      const w = window as any;
      w.proCalls = 0;
      w.proManifestCalls = 0;
      w.proGrants = routed ? ["pro-actors.manifests", "pro-actors.submit-target"] : [];
      w.proSubmissions = 0;
      if (routed) {
        initialSettings.proIntegrationMode = "on";
        initialSettings.serverUrl = "https://example.test";
        w.proManifests = [
          {
            dtype: "actor-manifest",
            extensions: {
              "starintel.actor_manifest.v1": {
                actor_id: "melissa",
                implementation: { repository: "lost-rob0t/starintel-pro-actors" }
              }
            }
          }
        ];
      }
      const inputs = routed
        ? [
            {
              _id: "person:ada",
              dtype: "person",
              title: "Ada",
              dataset: "test",
              data: { fname: "Ada", lname: "Lovelace" }
            }
          ]
        : [];
      w.proContext = React.createContext(null);
      function Harness() {
        const [settings, setSettings] = React.useState(initialSettings);
        const [status, setStatus] = React.useState({ connected: true });
        w.proConnection = (connected: boolean) => setStatus({ connected });

        const context = {
          documents: inputs,
          selectedDocuments: inputs,
          submitTarget: async () => {
            w.proSubmissions++;
          },
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
          routed
            ? React.createElement(
                Router.BrowserRouter,
                null,
                React.createElement(Router.Link, { to: "/actors" }, "Actors route"),
                React.createElement(Router.Link, { to: "/settings" }, "Settings route"),
                React.createElement(
                  Router.Routes,
                  null,
                  React.createElement(Router.Route, {
                    path: "/",
                    element: React.createElement(Panel)
                  }),
                  React.createElement(Router.Route, {
                    path: "/actors",
                    element: React.createElement(Panel)
                  }),
                  React.createElement(Router.Route, {
                    path: "/settings",
                    element: React.createElement(SettingsPage)
                  })
                )
              )
            : React.createElement(
                React.Fragment,
                null,
                React.createElement(SettingsPage),
                React.createElement(Panel)
              )
        );
      }
      const container = document.createElement("div");
      document.body.replaceChildren(container);
      createRoot(container).render(React.createElement(Harness));
    },
    { reactUrl, domUrl, routerUrl, routed }
  );
  return browserErrors;
}

test("Pro preference persists and gates the real panel with current host grants", async ({
  page
}) => {
  const browserErrors = await mountProHarness(page);
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

for (const deny of [false, true]) {
  test(`pending Pro authorization ${deny ? "denial" : "success"} cannot submit after route unmount and Off`, async ({
    page
  }) => {
    const errors = await mountProHarness(page, true);
    await page.getByRole("link", { name: "Actors route" }).click();
    await expect(page).toHaveURL(/\/actors$/);
    await page.evaluate((denied) => {
      (window as any).proDeny = denied;
    }, deny);
    await page.getByRole("button", { name: "Run Melissa", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Boolean((window as any).proAuthorizeRelease)))
      .toBe(true);
    await page.getByRole("link", { name: "Settings route" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator(".pro-actor-manager")).toHaveCount(0);
    await page.getByLabel("Pro integration mode").selectOption("off");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).proSaved)).toBe("off");
    await page.evaluate(async () => {
      (window as any).proAuthorizeRelease();
      // Allow the authorization continuation and React updates to settle.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
    });
    expect(await page.evaluate(() => (window as any).proSubmissions)).toBe(0);
    expect(await page.evaluate(() => (window as any).proNotice.message)).toBe(
      "Settings saved locally"
    );
    await page.getByRole("link", { name: "Actors route" }).click();
    await expect(page.locator(".pro-actor-manager")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("a mounted authorized Pro run still submits once", async ({ page }) => {
  const errors = await mountProHarness(page, true);
  await page.getByRole("link", { name: "Actors route" }).click();
  await page.getByRole("button", { name: "Run Melissa", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Boolean((window as any).proAuthorizeRelease)))
    .toBe(true);
  await page.evaluate(() => (window as any).proAuthorizeRelease());
  await expect.poll(() => page.evaluate(() => (window as any).proSubmissions)).toBe(1);
  await expect
    .poll(() => page.evaluate(() => (window as any).proNotice?.message))
    .toContain("to Pro actor melissa");
  expect(errors).toEqual([]);
});
