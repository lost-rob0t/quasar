import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function createPerson(page: Page, name: string) {
  await page.goto("/documents/new?dtype=person&returnTo=graph");
  for (const [field, value] of [
    ["fname", name],
    ["lname", "Test"],
    ["fullName", `${name} Test`]
  ]) {
    await page.getByLabel("Add optional field").selectOption(field);
    await page.getByLabel(field, { exact: true }).fill(value);
  }
  await page.getByRole("button", { name: "Save document", exact: true }).click();
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
