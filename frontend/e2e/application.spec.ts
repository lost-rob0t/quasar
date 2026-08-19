import { expect, test } from "./fixtures";

test("opens the local workspace through the control plane", async ({ page }) => {
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
  await expect(page.locator(".status-summary")).toBeVisible();
  await page.locator(".status-summary").click();
  const status = page.getByRole("dialog", { name: "Runtime status" });
  await expect(status).toBeVisible();
  await expect(status.getByText("Quasar control plane", { exact: true })).toBeVisible();
  await expect(status.getByText("Connected and authoritative", { exact: true })).toBeVisible();
  await expect(status.getByText("CouchDB sync", { exact: true })).toBeVisible();
  await expect(status.getByText("Local only", { exact: true })).toBeVisible();
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/graph");

  await expect(page.getByRole("heading", { name: "Start a blank graph" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add graph document" })).toBeVisible();
  await expect(page.getByLabel("Dataset filter", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Graph layout", { exact: true })).toBeVisible();

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
  await page.reload();
  await expect(page.locator(".graph-count")).toContainText("1 nodes");
});

test.describe("responsive application shell", () => {
  test("keeps identical global shell geometry across desktop routes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const homeSidebar = await page.locator(".quasar-shell > .sidebar").boundingBox();
    const homeTopbar = await page.locator(".quasar-shell .topbar").boundingBox();
    expect(homeSidebar).not.toBeNull();
    expect(homeTopbar).not.toBeNull();

    await page.goto("/graph");
    const graphSidebar = await page.locator(".quasar-shell > .sidebar").boundingBox();
    const graphTopbar = await page.locator(".quasar-shell .topbar").boundingBox();
    expect(graphSidebar?.width).toBe(homeSidebar?.width);
    expect(graphTopbar?.height).toBe(homeTopbar?.height);
    await expect(page.locator(".graph-workspace-host")).toBeVisible();
    await expect(page.locator(".graph-toolbar")).toBeVisible();
    await expect(page.locator(".graph-list-panel")).toBeHidden();
    await expect(page.locator(".graph-inspector")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Open graphs" })).toBeVisible();
    await expect(page.getByLabel("Graph statistics")).toBeVisible();
    await expect(page.getByLabel("Graph workspace dock")).toBeVisible();
    await expect(page.getByLabel("Dataset filter", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Graph layout", { exact: true })).toBeVisible();
  });

  test("uses gesture navigation without horizontal page overflow on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
    await page.getByRole("button", { name: "Open menu" }).click();
    const dialog = page.getByRole("dialog", { name: "Navigation" });
    const mobileNavigation = dialog.getByRole("navigation", { name: "Mobile navigation" });
    await expect(mobileNavigation).toBeVisible();
    await expect(mobileNavigation.getByText("Graphs")).toBeVisible();

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
        stageRect,
        editorRect
      };
    });
    expect(layout.stageRect?.x).toBeGreaterThanOrEqual(0);
    expect(layout.stageRect?.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.stageRect?.bottom).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.editorRect?.x).toBeGreaterThanOrEqual(0);
    expect(layout.editorRect?.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.editorRect?.bottom).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.pageWidth).toBe(layout.viewportWidth);

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
    await expect(page.locator(".agent-run-inspector")).toBeHidden();

    const layout = await page.evaluate(() => {
      const consoleRect = document.querySelector(".agent-console")?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pageWidth: document.documentElement.scrollWidth,
        consoleRect
      };
    });

    expect(layout.pageWidth).toBe(layout.viewportWidth);
    expect(layout.consoleRect?.top).toBeGreaterThanOrEqual(0);
    expect(layout.consoleRect?.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.consoleRect?.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  });
});
