import { expect, test } from "@playwright/test";

test("opens the local workspace without a backend", async ({ page }) => {
  const failedApplicationRequests: string[] = [];
  page.on("requestfailed", (request) => {
    if (["document", "script", "stylesheet"].includes(request.resourceType())) {
      failedApplicationRequests.push(request.url());
    }
  });

  await page.goto("/");

  await expect(page).toHaveTitle("Quasar");
  await expect(page.getByRole("heading", { name: "Statistics dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No documents loaded" })).toBeVisible();
  await expect(page.locator(".sidebar .sync-badge")).toHaveText("db offline");
  await expect(page.locator(".sidebar .sync-badge")).toHaveAttribute(
    "title",
    "CouchDB: Local only"
  );
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest"
  );
  expect(failedApplicationRequests).toEqual([]);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "StarIntel server" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "RabbitMQ graph ingest" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install/update map-reduce views" })).toBeVisible();
});

test("creates a graph node through the compact editor and preserves its full-editor draft", async ({
  page
}) => {
  await page.goto("/graph");

  await expect(page.getByRole("heading", { name: "Start a blank graph" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add graph document" })).toBeVisible();
  await expect(page.getByLabel("Dataset filter", { exact: true })).toBeHidden();
  await expect(page.getByLabel("Graph layout", { exact: true })).toBeHidden();

  await page.getByRole("button", { name: "Enter blank canvas" }).click();
  await page.locator(".graph-stage").click({ button: "right", position: { x: 240, y: 220 } });
  await expect(page.getByRole("menu", { name: "canvas actions" })).toBeVisible();
  await page.getByRole("button", { name: "Create person here" }).click();

  const compactEditor = page.getByRole("dialog", { name: "New Person" });
  await expect(compactEditor).toBeVisible();
  await expect(compactEditor.getByText("Fields for person")).toBeVisible();
  await expect(compactEditor.getByRole("button", { name: "Add field" })).toBeVisible();
  await expect(compactEditor.getByRole("button", { name: "Inspect JSON" })).toBeVisible();
  await expect(
    compactEditor.getByRole("button", { name: "Generate empty document" })
  ).toBeVisible();
  await compactEditor.getByLabel(/^First Name/).fill("Jane");
  await compactEditor.getByLabel(/^Last Name/).fill("Doe");
  await compactEditor.getByLabel(/^Display Name/).fill("Jane Doe");
  await compactEditor.getByRole("button", { name: "Open full editor" }).click();

  await expect(page).toHaveURL(/\/documents\/new\?.*draft=/);
  await expect(page.locator(".full-document-editor")).toBeVisible();
  await expect(page.getByRole("heading", { name: "New Person" })).toBeVisible();
  await expect(page.getByLabel(/^First Name/)).toHaveValue("Jane");
  await expect(page.getByLabel(/^Last Name/)).toHaveValue("Doe");
  await expect(page.getByLabel(/^Display Name/)).toHaveValue("Jane Doe");
  await page.locator(".editor-save-bar .primary").click();

  await expect(page).toHaveURL(/\/graph\?node=/);
  await expect(page.locator(".graph-count")).toContainText("1 nodes");
});

test.describe("responsive application shell", () => {
  test("preserves the desktop sidebar layout outside the graph", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".mobile-nav")).toBeHidden();
    await expect(page.locator(".app-shell")).toHaveCSS("grid-template-columns", "235px 1205px");
  });

  test("uses the investigation workspace without overlapping the graph on desktop", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/graph");

    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".topbar")).toBeVisible();
    await expect(page.locator(".graph-toolbar")).toBeHidden();
    await expect(page.locator(".graph-list-panel")).toBeHidden();
    await expect(page.locator(".graph-inspector")).toBeVisible();
    await expect(page.locator(".topbar .mobile-menu-button")).toBeHidden();
    await expect(
      page.locator(".graph-stage").getByRole("button", { name: "Open menu" })
    ).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Open graphs" })).toBeVisible();
    await expect(page.getByLabel("Graph statistics")).toBeVisible();
    await expect(page.getByLabel("Graph workspace dock")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cycle active graph" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select dataset" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cycle layout" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Graph tools" })).toHaveCount(0);

    const stage = await page.locator(".graph-stage").boundingBox();
    const inspector = await page.locator(".graph-inspector").boundingBox();
    const dock = await page.locator(".graph-agent-dock").boundingBox();
    expect(stage).not.toBeNull();
    expect(inspector).not.toBeNull();
    expect(dock).not.toBeNull();
    if (!stage || !inspector || !dock)
      throw new Error("Desktop workspace panels must be measurable");
    expect(stage.x).toBeGreaterThan(0);
    expect(stage.y).toBeGreaterThan(0);
    expect(stage.width).toBeGreaterThan(0);
    expect(stage.height).toBeGreaterThan(0);
    expect(stage.x + stage.width).toBeLessThanOrEqual(inspector.x);
    expect(stage.y + stage.height).toBeLessThanOrEqual(dock.y);

    await page.getByRole("button", { name: "Enter blank canvas" }).click();
    await page.locator(".graph-stage").click({
      button: "right",
      position: { x: 240, y: Math.min(220, stage.height - 20) }
    });
    await expect(page.getByRole("menu", { name: "canvas actions" })).toBeVisible();
  });

  test("uses gesture navigation without horizontal page overflow on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.locator(".mobile-nav")).toBeHidden();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
    await page.getByRole("button", { name: "Open menu" }).click();
    const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
    await expect(mobileNavigation).toBeVisible();
    await expect(mobileNavigation.getByText("Graph")).toBeVisible();
    await expect(page.locator(".dashboard-empty-page > .page-heading")).toHaveCSS(
      "text-align",
      "center"
    );
    await expect(page.locator(".dashboard-empty .button-row")).toHaveCSS(
      "justify-content",
      "center"
    );
    const viewport = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(viewport.scrollWidth).toBe(viewport.clientWidth);
  });

  test("keeps the mobile graph and compact editor inside the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/graph");

    await expect(page.locator(".graph-stage")).toBeVisible();
    await expect(page.locator(".graph-toolbar")).toBeHidden();
    await expect(page.locator(".graph-list-panel")).toBeHidden();
    await expect(page.locator(".graph-inspector")).toBeHidden();
    await expect(page.getByRole("button", { name: "Graph tools" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add graph document" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import", exact: true })).toBeVisible();
    await expect(page.locator(".graph-mobile-primary-button")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Search graph" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Cycle active graph" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Select dataset" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Cycle layout" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Fit graph" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Focus selection" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Toggle labels" })).toBeHidden();

    await page.getByRole("button", { name: "Add graph document" }).click();
    const compactEditor = page.getByRole("dialog", { name: "New Entity" });
    await expect(compactEditor).toBeVisible();
    await expect(compactEditor.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(compactEditor.getByRole("button", { name: "Save" })).toBeVisible();

    const layout = await page.evaluate(() => {
      const stageRect = document.querySelector(".graph-stage")?.getBoundingClientRect();
      const editorRect = document.querySelector(".graph-compact-editor")?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pageWidth: document.documentElement.scrollWidth,
        pageHeight: document.documentElement.scrollHeight,
        stageRect,
        editorRect
      };
    });
    expect(layout.stageRect?.x).toBe(0);
    expect(layout.stageRect?.y).toBe(0);
    expect(layout.stageRect?.width).toBe(layout.viewportWidth);
    expect(layout.stageRect?.height).toBe(layout.viewportHeight);
    expect(layout.editorRect?.x).toBe(0);
    expect(layout.editorRect?.width).toBe(layout.viewportWidth);
    expect(layout.editorRect?.bottom).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.pageWidth).toBe(layout.viewportWidth);
    expect(layout.pageHeight).toBe(layout.viewportHeight);

    await compactEditor.getByRole("button", { name: "Cancel" }).click();
    await expect(compactEditor).toBeHidden();
  });

  test("fits agent chat inside the mobile PWA viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/agents?tab=run");

    await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible();
    const chatPicker = page.getByRole("button", { name: /Other chats:/ });
    await expect(chatPicker).toBeVisible();
    await chatPicker.click();
    await expect(page.getByRole("textbox", { name: "Search chats" })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Other chats" })).toBeVisible();
    await expect(page.getByText("No chats found.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("textbox", { name: "Search chats" })).toBeHidden();
    await expect(page.getByLabel("Console section")).toHaveValue("run");
    await expect(page.locator(".agent-console-tabs")).toBeHidden();
    await expect(page.locator('.agent-console[data-tab="run"]')).toHaveCSS("position", "fixed");
    await expect(page.locator(".agent-run-inspector")).toBeHidden();

    const layout = await page.evaluate(() => {
      const consoleRect = document.querySelector(".agent-console")?.getBoundingClientRect();
      const navRect = document.querySelector(".mobile-nav")?.getBoundingClientRect();
      return {
        viewportHeight: window.innerHeight,
        pageHeight: document.documentElement.scrollHeight,
        consoleTop: consoleRect?.top,
        consoleBottom: consoleRect?.bottom,
        navTop: navRect?.top
      };
    });

    expect(layout.pageHeight).toBe(layout.viewportHeight);
    expect(layout.consoleTop).toBeGreaterThanOrEqual(0);
    expect(layout.consoleBottom).toBeLessThanOrEqual(layout.navTop || layout.viewportHeight);
  });
});
