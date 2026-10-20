import { expect, test } from "./fixtures";

test("opens the datasets navigation as a dataset index", async ({ page }) => {
  await page.goto("/documents?group=dataset");

  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search datasets" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Documents" })).toHaveCount(0);
});

test("datasets explains an empty corpus and clears a search", async ({ page }) => {
  await page.goto("/datasets");
  await expect(page.getByText("No datasets yet. Add a document to get started.")).toBeVisible();
  await page.getByRole("textbox", { name: "Search datasets" }).fill("missing");
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByRole("textbox", { name: "Search datasets" })).toHaveValue("");
});

test("document detail and edit return to filtered results", async ({ page }, testInfo) => {
  await page.goto("/documents/new?dtype=person&dataset=usability-test");
  await page.getByLabel("id", { exact: true }).fill("person:usability-return");
  await page.getByLabel("Add optional field").selectOption("fullName");
  await page.getByLabel("fullName", { exact: true }).fill("Usability Return");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/person%3Ausability-return$/);

  await page.goto("/documents?dataset=usability-test&q=Return");
  await expect(page.getByRole("link", { name: "Usability Return" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("filtered-documents.png"), fullPage: true });
  await page.getByRole("link", { name: "Usability Return" }).click();
  await expect(page.getByRole("link", { name: "Back to results" })).toBeVisible();
  await page.getByRole("link", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await expect(page.getByRole("link", { name: "Back to results" })).toBeVisible();
  await page.getByRole("link", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("link", { name: "Back to results" }).click();
  await expect(page).toHaveURL(/\/documents\?dataset=usability-test&q=Return$/);
  await expect(page.getByRole("link", { name: "Usability Return" })).toBeVisible();
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
