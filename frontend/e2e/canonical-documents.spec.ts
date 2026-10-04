import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("native canonical create, reload, edit, cancel, export and validation", async ({
  page
}, testInfo) => {
  await page.goto("/documents/new?dtype=person&dataset=canonical-test");
  await expect(page.getByRole("heading", { name: "New document" })).toBeVisible();
  await page.getByLabel("id", { exact: true }).fill("person:canonical-browser");
  await page.getByLabel("Add optional field").selectOption("fullName");
  await page.getByLabel("fullName", { exact: true }).fill("Canonical Ada");
  await page.screenshot({ path: testInfo.outputPath("canonical-create.png"), fullPage: true });
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/person%3Acanonical-browser$/);
  await page.reload();
  await expect(page.getByText("Canonical Ada", { exact: true }).first()).toBeVisible();

  await page.goto("/documents/person%3Acanonical-browser/edit");
  await expect(page.getByLabel("fullName", { exact: true })).toHaveValue("Canonical Ada");
  await page.getByLabel("fullName", { exact: true }).fill("Canonical Ada Updated");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/person%3Acanonical-browser$/);
  await page.goto("/documents/person%3Acanonical-browser/edit");
  await expect(page.getByLabel("fullName", { exact: true })).toHaveValue("Canonical Ada Updated");
  await page.getByLabel("fullName", { exact: true }).fill("Cancelled name");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/\/documents$/);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export results", exact: true }).click();
  const download = await downloadPromise;
  const output = await readFile((await download.path())!, "utf8");
  const saved = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((doc) => doc.id === "person:canonical-browser");
  expect(saved.schemaVersion).toBe("0.10.1");
  expect(saved.fullName).toBe("Canonical Ada Updated");
  expect(saved).not.toHaveProperty("data");
  expect(saved).not.toHaveProperty("_id");
  await page.screenshot({ path: testInfo.outputPath("canonical-saved.png"), fullPage: true });

  await page.goto("/documents/new?dtype=person");
  await page.getByRole("button", { name: "Edit raw JSON", exact: true }).click();
  await page.getByLabel("Canonical document JSON").fill(
    JSON.stringify({
      id: "bad",
      dtype: "person",
      dataset: "test",
      schemaVersion: "0.10.1",
      data: {}
    })
  );
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("additional properties");
  await expect(page).toHaveURL(/\/documents\/new/);
});
