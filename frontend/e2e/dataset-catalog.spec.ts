import { expect, test } from "./fixtures";

test("real dataset catalog pages replace rows and retain canonical counts", async ({ page }) => {
  await page.goto("/datasets");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/control-plane/client.ts";
        return (await import(path)).getControlPlane()?.getConnected();
      })
    )
    .toBe(true);
  await page.evaluate(async () => {
    const path = "/src/control-plane/client.ts";
    const client = (await import(path)).getControlPlane();
    await client.transaction(
      Array.from({ length: 51 }, (_, index) => ({
        type: "document.create",
        payload: {
          id: `person:catalog-${index}`,
          dtype: "person",
          dataset: `catalog-${String(index).padStart(2, "0")}`,
          schemaVersion: "0.10.1",
          fullName: `Person ${index}`,
          updatedAt: 0
        }
      }))
    );
  });
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await expect(page.locator("tbody tr").first()).toContainText("catalog-00");
  await expect(page.locator("tbody tr").first().locator("td").nth(1)).toHaveText("1");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("catalog-50");
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(50);
});
