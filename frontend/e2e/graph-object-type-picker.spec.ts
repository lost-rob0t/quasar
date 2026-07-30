import { expect, test } from "@playwright/test";

test("searches every known graph object type before opening the compact editor", async ({
  page
}) => {
  await page.goto("/graph");

  await page.getByRole("button", { name: "Enter blank canvas" }).click();
  await page.locator(".graph-stage").click({ button: "right", position: { x: 240, y: 220 } });
  await page.getByRole("menuitem", { name: "Create node" }).click();
  await page
    .getByRole("menu", { name: "create actions" })
    .getByRole("menuitem", { name: "Other object type" })
    .click();

  const picker = page.getByRole("dialog", { name: "Select object type" });
  await expect(picker).toBeVisible();
  const search = picker.getByRole("combobox", { name: "Search object types" });
  await expect(search).toBeVisible();
  await expect(picker.getByRole("listbox", { name: "Object types" })).toBeVisible();

  await search.fill("target");
  await expect(picker.getByRole("option", { name: /Target target/ })).toBeVisible();
  await picker.getByRole("option", { name: /Target target/ }).click();

  await expect(page.getByRole("dialog", { name: "New Target" })).toBeVisible();
  await expect(page.getByText("Fields for target")).toBeVisible();
});
