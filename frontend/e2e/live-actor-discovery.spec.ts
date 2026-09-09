import { expect, test } from "@playwright/test";

const liveServerUrl = process.env.STAR_ACTOR_E2E_SERVER_URL || "";

test.describe("live StarIntel actor discovery", () => {
  test.skip(!liveServerUrl, "STAR_ACTOR_E2E_SERVER_URL is required for the live cross-service check");

  test("shows local Lisp and remote BBPD actors in Actor Studio", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("Server URL").fill(liveServerUrl);
    await page.getByRole("button", { name: "Test server connection" }).click();
    await expect(page.getByText("Connected to StarIntel API v1")).toBeVisible();

    await page.goto("/actors");
    await expect(page.getByText(/Discovered \d+ StarIntel server actor\(s\)\./)).toBeVisible();

    const actors = page.getByRole("listbox", { name: "Actors" });
    const local = actors.locator("button").filter({ hasText: "local · Lisp" }).first();
    await expect(local).toBeVisible();
    await local.click();
    await expect(
      page.getByText(/Server-managed actor: local via starintel-gserver · common-lisp · sento/)
    ).toBeVisible();

    const remote = actors.locator("button").filter({ hasText: "Subfinder" }).first();
    await expect(remote).toContainText("remote · python");
    await remote.click();
    await expect(
      page.getByText(/Server-managed actor: remote via bbp-actors · python · rabbitmq/)
    ).toBeVisible();

    await page.getByRole("button", { name: "config" }).click();
    await expect(page.getByText("Deployment manifest JSON")).toBeVisible();
    await expect(page.locator("textarea.actor-code-editor")).toHaveValue(
      /starintel-actor-deployment-manifest-v1/
    );
  });
});
