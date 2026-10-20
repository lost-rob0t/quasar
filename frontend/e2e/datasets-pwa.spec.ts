import { expect, test } from "./fixtures";

test("opens the datasets navigation as a dataset index", async ({ page }) => {
  await page.goto("/documents?group=dataset");

  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search datasets" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Documents" })).toHaveCount(0);
});

test("document search preserves useful browser history and explains an empty corpus", async ({
  page
}) => {
  await page.goto("/datasets");
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(page.getByText("No documents loaded yet.")).toBeVisible();

  await page.getByRole("textbox", { name: "Search documents" }).pressSequentially("missing");
  await expect(page.getByText("No documents match these filters.")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/datasets$/);
});

test("exposes browser app installation from the Common Lisp port", async ({ page }) => {
  await page.goto("/graph");

  await expect(page.getByRole("button", { name: "Install Quasar" })).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest"
  );
});
