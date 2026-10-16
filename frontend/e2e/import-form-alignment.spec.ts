import { expect, test } from "./fixtures";

test("import form uses the Quasar field and surface system", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/import");

  const sourcePanel = page.locator(".import-source-panel");
  const format = page.getByLabel("Source format");
  const uploadCards = page.locator(".upload-card");
  await expect(sourcePanel).toBeVisible();
  await expect(format).toBeVisible();
  await expect(uploadCards).toHaveCount(2);

  const [panelBox, formatBox, firstUploadBox, secondUploadBox] = await Promise.all([
    sourcePanel.boundingBox(),
    format.boundingBox(),
    uploadCards.nth(0).boundingBox(),
    uploadCards.nth(1).boundingBox()
  ]);

  expect(panelBox).not.toBeNull();
  expect(formatBox).not.toBeNull();
  expect(firstUploadBox).not.toBeNull();
  expect(secondUploadBox).not.toBeNull();
  expect(formatBox!.width).toBeGreaterThan(400);
  expect(formatBox!.x).toBeGreaterThan(panelBox!.x);
  expect(Math.abs(firstUploadBox!.y - secondUploadBox!.y)).toBeLessThan(2);
  expect(Math.abs(firstUploadBox!.width - secondUploadBox!.width)).toBeLessThan(2);

  await expect(uploadCards.nth(0).locator("svg")).toHaveCSS("color", "rgb(246, 201, 69)");
  await expect(format).not.toHaveCSS("background-color", "rgb(255, 255, 255)");
});

test("import form stacks cleanly on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/import");

  const uploadCards = page.locator(".upload-card");
  const [firstUploadBox, secondUploadBox] = await Promise.all([
    uploadCards.nth(0).boundingBox(),
    uploadCards.nth(1).boundingBox()
  ]);

  expect(firstUploadBox).not.toBeNull();
  expect(secondUploadBox).not.toBeNull();
  expect(secondUploadBox!.y).toBeGreaterThan(firstUploadBox!.y + firstUploadBox!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator(".import-actions")).toHaveCSS("grid-template-columns", /\d+(\.\d+)?px/);
});
