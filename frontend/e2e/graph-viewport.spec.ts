import { expect, test, type Locator } from "@playwright/test";

type ViewportState = {
  panX: number;
  panY: number;
  zoom: number;
};

async function viewportState(canvas: Locator): Promise<ViewportState> {
  return canvas.evaluate((element: HTMLElement) => ({
    panX: Number(element.dataset.graphPanX),
    panY: Number(element.dataset.graphPanY),
    zoom: Number(element.dataset.graphZoom)
  }));
}

test("desktop graph canvas pans and zooms", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/graph");

  const canvas = page.locator(".graph-canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await viewportState(canvas)).zoom).toBeGreaterThan(0);

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;

  const start = {
    x: bounds.x + bounds.width * 0.62,
    y: bounds.y + bounds.height * 0.72
  };
  const beforePan = await viewportState(canvas);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 120, start.y + 70, { steps: 10 });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const current = await viewportState(canvas);
      return Math.abs(current.panX - beforePan.panX) + Math.abs(current.panY - beforePan.panY);
    })
    .toBeGreaterThan(40);

  const beforeZoom = await viewportState(canvas);
  await page.mouse.move(start.x, start.y);
  await page.mouse.wheel(0, -600);

  await expect
    .poll(async () => (await viewportState(canvas)).zoom)
    .toBeGreaterThan(beforeZoom.zoom);
});

test("full viewport keeps the modern graph workspace shell", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/graph");

  const body = page.locator("body");
  const canvas = page.locator(".graph-canvas");
  const sidebar = page.locator(".app-shell > .sidebar");
  const topbar = page.locator(".topbar");
  const metrics = page.locator(".graph-workspace-metrics");
  const dock = page.locator(".graph-agent-dock");
  const inspector = page.locator(".graph-inspector");
  const activity = page.locator(".graph-recent-activity");

  await expect(sidebar).toBeVisible();
  await expect(topbar).toBeVisible();
  await expect(metrics).toBeVisible();
  await expect(dock).toBeVisible();
  await expect(inspector).toBeVisible();
  await expect(activity).toBeVisible();
  await expect(canvas).toBeVisible();

  const canvasBefore = await canvas.boundingBox();
  const sidebarBefore = await sidebar.boundingBox();
  expect(canvasBefore).not.toBeNull();
  expect(sidebarBefore).not.toBeNull();

  await page.getByRole("button", { name: "Enter full viewport" }).click();

  await expect(body).toHaveClass(/graph-viewport-full/);
  await expect(sidebar).toBeVisible();
  await expect(topbar).toBeVisible();
  await expect(metrics).toBeVisible();
  await expect(dock).toBeVisible();
  await expect(inspector).toBeVisible();
  await expect(activity).toBeVisible();
  await expect(page.getByRole("button", { name: "Exit full viewport" })).toBeVisible();

  const canvasAfter = await canvas.boundingBox();
  const sidebarAfter = await sidebar.boundingBox();
  expect(canvasAfter).not.toBeNull();
  expect(sidebarAfter).not.toBeNull();
  if (canvasBefore && canvasAfter && sidebarBefore && sidebarAfter) {
    expect(sidebarAfter.width).toBeLessThan(sidebarBefore.width - 100);
    expect(canvasAfter.width).toBeGreaterThan(canvasBefore.width + 120);
    expect(canvasAfter.height).toBeGreaterThan(canvasBefore.height + 35);
  }

  await page.keyboard.press("Escape");
  await expect(body).not.toHaveClass(/graph-viewport-full/);
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter full viewport" })).toBeVisible();
});
