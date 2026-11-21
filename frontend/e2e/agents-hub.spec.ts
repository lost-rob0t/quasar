import { expect, test } from "./fixtures";

test.use({ crashGuard: true });

// The agents hub (/agents) renders the Operator console; the tab strip
// drives the ?tab= search param. The legacy ?section=actors deep-link
// redirects to /actors.
test("operator console renders and tabs drive sections", async ({ page }) => {
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Operator console" })).toBeVisible();
  await expect(page.locator(".agent-console-tabs button.active")).toHaveText("run");

  for (const tab of ["agents", "providers", "skills"]) {
    await page.locator(".agent-console-tabs button", { hasText: tab }).click();
    await expect(page).toHaveURL(new RegExp(`tab=${tab}`));
    await expect(page.locator(".agent-console-tabs button.active")).toHaveText(tab);
  }

  await page.goto("/agents?section=actors");
  await expect(page).toHaveURL(/\/actors$/);
});
