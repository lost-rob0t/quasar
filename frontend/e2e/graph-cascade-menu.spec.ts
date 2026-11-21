import { expect, test } from "./fixtures";

// Cascade right-click menus (CascadingMenu.jsx): the stage-level pointerdown
// close-guard must exempt the menu itself (.cascading-menu) or every item
// press unmounts the menu before the click can act (operator regression,
// 2026-11-20 — pointerdown precedes click).
test("cascade stays open across item presses and leaf actions open the editor", async ({
  page
}) => {
  await page.goto("/graph");
  await page.getByRole("button", { name: "Enter blank canvas" }).click();
  await page.locator(".graph-stage").click({ button: "right", position: { x: 240, y: 220 } });

  await expect(page.locator(".cascading-menu")).toBeVisible();

  // Pressing a submenu parent (full pointerdown -> click sequence) must open
  // the child panel, not unmount the menu.
  await page.getByRole("menuitem", { name: "Create", exact: true }).click();
  await expect(page.locator(".cascading-panel")).toHaveCount(2);
  await expect(page.getByRole("menuitem", { name: "Create person" })).toBeVisible();

  await page.getByRole("menuitem", { name: "Create person" }).click();
  await expect(page.locator(".graph-node-editor")).toBeVisible();
  await expect(page.locator(".cascading-menu")).toHaveCount(0);
});

test("cascade closes on a press outside the menu", async ({ page }) => {
  await page.goto("/graph");
  await page.getByRole("button", { name: "Enter blank canvas" }).click();
  await page.locator(".graph-stage").click({ button: "right", position: { x: 240, y: 220 } });
  await expect(page.locator(".cascading-menu")).toBeVisible();

  // Raw mouse press: canvas selection handlers keep the stage "unstable"
  // during Playwright's actionability retries, so bypass them.
  await page.mouse.click(760, 520);
  await expect(page.locator(".cascading-menu")).toHaveCount(0);
});

test("escape backs out of a submenu, then closes the cascade", async ({ page }) => {
  await page.goto("/graph");
  await page.getByRole("button", { name: "Enter blank canvas" }).click();
  await page.locator(".graph-stage").click({ button: "right", position: { x: 240, y: 220 } });
  await page.getByRole("menuitem", { name: "Create", exact: true }).click();
  await expect(page.locator(".cascading-panel")).toHaveCount(2);

  await page.keyboard.press("Escape");
  await expect(page.locator(".cascading-panel")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".cascading-menu")).toHaveCount(0);
});
