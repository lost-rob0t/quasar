import { expect, test, type Page } from "@playwright/test";

async function installDatasetOptions(page: Page) {
  await page.getByLabel("Dataset filter", { exact: true }).evaluate((select) => {
    const replacement = select.cloneNode(false) as HTMLSelectElement;
    replacement.innerHTML = `
      <option value="all-datasets">All datasets</option>
      <option value="alpha">Alpha research</option>
      <option value="bravo">Bravo archive</option>
    `;
    replacement.value = "all-datasets";
    replacement.addEventListener("change", () => {
      replacement.dataset.lastChange = replacement.value;
    });
    select.replaceWith(replacement);
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const width = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth
  }));
  expect(width.scroll).toBe(width.client);
}

test("searches and selects a dataset from the desktop graph button", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/graph");
  await installDatasetOptions(page);

  const button = page.getByRole("button", { name: "Select dataset" });
  await button.click();

  const dialog = page.getByRole("dialog", { name: "Select dataset" });
  const search = dialog.getByRole("searchbox", { name: "Search datasets" });
  const listbox = page.getByRole("listbox", { name: "Datasets" });
  const allDatasets = listbox.getByRole("option", { name: "All datasets" });
  const alpha = listbox.getByRole("option", { name: "Alpha research" });
  const bravo = listbox.getByRole("option", { name: "Bravo archive" });
  await expect(dialog).toBeVisible();
  await expect(search).toBeFocused();
  await expect(allDatasets).toHaveAttribute("aria-selected", "true");

  await search.fill("alpha");
  await expect(alpha).toBeVisible();
  await expect(bravo).toBeHidden();
  await search.press("ArrowDown");
  await expect(alpha).toBeFocused();
  await alpha.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Dataset filter", { exact: true })).toHaveValue("alpha");
  await expect(page.getByLabel("Dataset filter", { exact: true })).toHaveAttribute(
    "data-last-change",
    "alpha"
  );
  await expect(button).toHaveAttribute("title", /Alpha research/);

  await button.click();
  await expect(search).toHaveValue("");
  await search.fill("bravo");
  await bravo.click();
  await expect(page.getByLabel("Dataset filter", { exact: true })).toHaveValue("bravo");
  await expect(dialog).toBeHidden();
  await expectNoHorizontalOverflow(page);
});

test("searches and selects a dataset from the mobile graph tools tray", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/graph");
  await installDatasetOptions(page);

  await page.getByRole("button", { name: "Graph tools" }).click();
  await page
    .getByRole("menu", { name: "Graph tools" })
    .getByRole("menuitem", { name: "Dataset" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Select dataset" });
  const search = dialog.getByRole("searchbox", { name: "Search datasets" });
  const listbox = page.getByRole("listbox", { name: "Datasets" });
  await expect(dialog).toBeVisible();
  await expect(search).toBeFocused();
  await expect(page.getByRole("menu", { name: "Graph tools" })).toBeHidden();
  await search.fill("alpha");
  await listbox.getByRole("option", { name: "Alpha research" }).click();
  await expect(page.getByLabel("Dataset filter", { exact: true })).toHaveValue("alpha");
  await expect(page.getByLabel("Dataset filter", { exact: true })).toHaveAttribute(
    "data-last-change",
    "alpha"
  );
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Graph tools" }).click();
  await page
    .getByRole("menu", { name: "Graph tools" })
    .getByRole("menuitem", { name: "Dataset" })
    .click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expectNoHorizontalOverflow(page);
});
