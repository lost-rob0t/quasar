import { expect, test } from "@playwright/test";

const expectedLinks = [
  ["Home", "/"],
  ["Graphs", "/graph"],
  ["Datasets", "/datasets"],
  ["Documents", "/documents"],
  ["Add document", "/documents/new"],
  ["Agents", "/agents"],
  ["Actors", "/actors"],
  ["Import", "/import"],
  ["Settings", "/settings"]
];

test("mobile menu mirrors the desktop workspace navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");

  await page.getByRole("button", { name: "Open navigation" }).click();

  const dialog = page.getByRole("dialog", { name: "Navigation" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Quasar", { exact: true })).toBeVisible();

  const navigation = dialog.getByRole("navigation", { name: "Mobile navigation" });
  await expect(navigation.getByRole("link")).toHaveCount(expectedLinks.length);

  for (const [label, href] of expectedLinks) {
    const link = navigation.getByRole("link", { name: label, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", href);
  }

  await expect(navigation.getByRole("link", { name: "Settings", exact: true })).toHaveClass(
    /active/
  );
  await expect(dialog.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Redo", exact: true })).toBeVisible();
});
