import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Requires the real Quasar WebSocket + Tek9 backend from playwright.config.ts.
// No network or storage mocks: local files below contain synthetic radio data.
test("Import UI: StarIntel, WiGLE, Kismet, rejection and reload", async ({ page }, info) => {
  await page.goto("/import");
  await expect(page.getByRole("heading", { name: "Import documents", exact: true })).toBeVisible();
  const dataset = `wireless-ui-${Date.now()}`;
  const fixtures = new URL("../tests/fixtures/wireless/", import.meta.url);
  for (const [format, name] of [
    ["wigle-csv", "wigle.csv"],
    ["kismet-json", "kismet.jsonl"]
  ]) {
    await page.getByLabel("Source format").selectOption(format);
    await page.getByLabel("Dataset", { exact: true }).fill(dataset);
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name,
        mimeType: "text/plain",
        buffer: await readFile(new URL(name, fixtures))
      });
    await page.screenshot({ path: info.outputPath(`${format}-selected.png`), fullPage: true });
    await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await expect(page.getByText("Imported 3 document(s)", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${format}-persisted.png`), fullPage: true });
    await page.reload();
  }
  await page.getByLabel("Source format").selectOption("starintel");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "canonical.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          id: `${dataset}:document`,
          dtype: "document",
          dataset,
          schemaVersion: "0.10.1"
        })
      )
    });
  await page.getByRole("button", { name: "Save locally", exact: true }).click();
  await expect(page.getByText("Imported 1 document(s)", { exact: true })).toBeVisible();
  await page.getByLabel("Source format").selectOption("wigle-csv");
  await page.getByLabel("Dataset", { exact: true }).fill(dataset);
  const broken = (await readFile(new URL("wigle.csv", fixtures), "utf8")).replace(",-42,", ",NaN,");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: "invalid.csv", mimeType: "text/csv", buffer: Buffer.from(broken) });
  await page.getByRole("button", { name: "Save locally", exact: true }).click();
  await expect(
    page.getByText("Atomic import rejected 1 parse error(s)", { exact: true })
  ).toBeVisible();
  await expect(page.getByText(/Invalid RSSI/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("wireless-rejected.png"), fullPage: true });
});
