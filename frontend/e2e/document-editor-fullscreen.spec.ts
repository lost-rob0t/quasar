import { expect, test } from "./fixtures";

test("gives the full document editor the complete viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/documents/new?dtype=person&advanced=1");

  await expect(page.locator(".quasar-shell")).toHaveClass(/document-editor-fullscreen/);
  await expect(page.locator(".quasar-shell > .sidebar")).toBeHidden();
  await expect(page.locator(".quasar-shell .topbar")).toBeHidden();
  await expect(page.locator(".quasar-shell > .mobile-nav")).toBeHidden();
  await expect(page.getByRole("button", { name: "Close full editor" })).toBeVisible();

  const viewport = await page.locator(".content-editor-fullscreen").evaluate((element) => {
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
  expect(viewport).toEqual({
    left: 0,
    top: 0,
    right: viewport.width,
    bottom: viewport.height,
    width: 1440,
    height: 900
  });
});
