import { expect, test } from "./fixtures";

test("imports a corpus larger than one control-plane message without disconnecting", async ({
  page
}) => {
  test.setTimeout(120_000);
  const count = 2_001;
  const formattedCount = count.toLocaleString("en-US");
  const runId = Date.now().toString(36);
  const stamp = "2026-01-01T00:00:00.000Z";
  const documents = Array.from({ length: count }, (_, index) => ({
    _id: `starintel:org:large-import-${runId}-${index}`,
    dataset: "large-import",
    dtype: "org",
    schema_version: "0.9.0",
    version: 1,
    date_added: stamp,
    date_updated: stamp,
    title: `Large import organization ${index}`,
    description: "x".repeat(700),
    sources: [],
    evidence: [],
    data: { name: `Large import organization ${index}` }
  }));
  const body = JSON.stringify(documents);
  expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);

  await page.goto("/import");
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "large-import.json",
      mimeType: "application/json",
      buffer: Buffer.from(body)
    });
  await page.getByRole("button", { name: "Save locally" }).click();

  await expect(page.getByText(`Imported ${count} document(s)`)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("heading", { name: "Import report" })).toBeVisible();
  await expect(page.locator(".import-report")).toContainText(`Saved${count}`);
  await expect(page.getByText("The Common Lisp control plane disconnected.")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".sidebar")).toContainText(`${formattedCount} documents`, {
    timeout: 90_000
  });
  await expect(page.getByText("The Common Lisp control plane disconnected.")).toHaveCount(0);

  await page.goto("/graph?review=all");
  await expect(page.getByRole("heading", { name: "Graph load blocked" })).toHaveCount(0);
  await expect(page.locator(".graph-canvas")).toBeVisible({ timeout: 90_000 });
  const graphCount = page.locator(".graph-count");
  await expect(graphCount).toContainText(`${count} nodes`, { timeout: 90_000 });
  await expect(page.getByText("The Common Lisp control plane disconnected.")).toHaveCount(0);
});