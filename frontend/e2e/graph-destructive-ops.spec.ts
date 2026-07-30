import { expect, test, type Page } from "@playwright/test";

async function createPerson(page: Page, name: string) {
  await page.goto("/documents/new?dtype=person&returnTo=graph");
  await page.getByLabel(/^First Name/).fill(name);
  await page.getByLabel(/^Last Name/).fill("Test");
  await page.getByLabel(/^Display Name/).fill(`${name} Test`);
  await page.locator(".editor-save-bar .primary").click();
  await expect(page).toHaveURL(/\/graph\?node=/);
}

test("deletes a selected graph document from the corpus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createPerson(page, "Delete");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete selected documents" }).click();
  await expect(page.locator(".graph-count")).toContainText("0 nodes");
});

test("clears the all-documents view into a new empty graph on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createPerson(page, "Clear");
  await page.getByRole("button", { name: "Graph tools" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("menu", { name: "Graph tools" })
    .getByRole("menuitem", { name: "Clear" })
    .click();
  await expect(page.getByLabel("Active graph", { exact: true })).not.toHaveValue("all-documents");
  await expect(page.locator(".graph-count")).toContainText("0 nodes");
});
