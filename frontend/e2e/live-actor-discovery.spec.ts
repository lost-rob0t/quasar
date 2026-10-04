import { expect, test } from "@playwright/test";

const liveServerUrl = process.env.STAR_ACTOR_E2E_SERVER_URL || "";
const liveServerToken = process.env.STAR_ACTOR_E2E_SERVER_TOKEN || "";

test.describe("live StarIntel actor discovery", () => {
  test.skip(
    !liveServerUrl,
    "STAR_ACTOR_E2E_SERVER_URL is required for the live cross-service check"
  );

  test("lists live registry entries and selects an actor in Actor Studio", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("Server URL").fill(liveServerUrl);
    if (liveServerToken) await page.getByLabel("Bearer token").fill(liveServerToken);
    await page.getByRole("button", { name: "Test server connection" }).click();
    await expect(page.getByText("Connected to StarIntel API v1")).toBeVisible();

    await page.goto("/actors");
    await expect(page.getByText(/Discovered \d+ registry entries; \d+ alive\./)).toBeVisible();

    const actors = page.getByRole("listbox", { name: "Actors" });
    const local = actors.locator("button").filter({ hasText: "actor · alive" }).first();
    await expect(local).toBeVisible();
    await local.click();
    await expect(page.getByText(/Registry-managed actor: online · ready/)).toBeVisible();

    await page.getByRole("button", { name: "config" }).click();
    await expect(page.getByText("Actor registry entry JSON")).toBeVisible();
    await expect(page.getByLabel("Actor registry entry JSON")).toHaveValue(/resourceUri/);
  });
});
