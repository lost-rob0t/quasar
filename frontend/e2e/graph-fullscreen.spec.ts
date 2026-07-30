import { expect, test } from "@playwright/test";

test("uses a compact modern shell in full viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/graph");

  const stage = page.locator(".graph-stage");
  const sidebar = page.locator(".app-shell > .sidebar");
  const topbar = page.locator(".topbar");
  const metrics = page.locator(".graph-workspace-metrics");
  const inspector = page.locator(".graph-inspector");
  const dock = page.locator(".graph-agent-dock");

  await expect(stage).toBeVisible();
  await expect(sidebar).toBeVisible();
  const defaultBounds = await stage.boundingBox();
  expect(defaultBounds).not.toBeNull();
  expect(defaultBounds!.height).toBeGreaterThan(540);

  await page.getByRole("button", { name: "Enter full viewport" }).click();
  await expect(page.locator("body")).toHaveClass(/graph-viewport-full/);
  await expect(sidebar).toBeVisible();
  await expect(topbar).toBeVisible();
  await expect(metrics).toBeVisible();
  await expect(inspector).toBeVisible();
  await expect(dock).toBeVisible();

  const fullBounds = await stage.boundingBox();
  expect(fullBounds).not.toBeNull();
  expect(fullBounds!.width).toBeGreaterThan(defaultBounds!.width + 120);
  expect(fullBounds!.height).toBeGreaterThan(defaultBounds!.height + 35);

  const viewport = await stage.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      width: window.innerWidth,
      height: window.innerHeight
    };
  });

  expect(viewport.left).toBeGreaterThanOrEqual(0);
  expect(viewport.top).toBeGreaterThanOrEqual(0);
  expect(viewport.right).toBeLessThanOrEqual(viewport.width);
  expect(viewport.bottom).toBeLessThanOrEqual(viewport.height);

  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/graph-viewport-full/);
  await expect(sidebar).toBeVisible();

  const graphMenu = stage.getByRole("button", { name: "Open menu" });
  await expect(graphMenu).toBeVisible();

  await graphMenu.click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Graph", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Docs", exact: true })).toBeVisible();
});
