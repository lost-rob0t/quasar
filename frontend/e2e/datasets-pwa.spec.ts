import { expect, test } from "./fixtures";

test("opens the datasets navigation as a dataset index", async ({ page }) => {
  await page.goto("/documents?group=dataset");

  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search datasets" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Documents" })).toHaveCount(0);
});

test("exposes browser app installation from the Common Lisp port", async ({ page }) => {
  await page.goto("/graph");

  await expect(page.getByRole("button", { name: "Install Quasar" })).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest"
  );
});
