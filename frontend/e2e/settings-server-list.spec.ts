import { expect, test } from "./fixtures";
import { configureStarServer } from "./helpers";

// Regression (forgejo #148): the Saved-servers state (serverListName) was
// declared in ImportPage while its JSX lives in SettingsPage, crashing
// /settings with "serverListName is not defined". The page must render and
// the save-a-connection flow must work end to end.
test("settings renders and saves the current connection under a name", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await configureStarServer(page);
  await page.goto("/settings");

  await expect(page.getByPlaceholder("http://localhost:5000")).toBeVisible();

  await page.getByLabel("Server name").fill("local dev");
  await page.getByRole("button", { name: "Save current connection" }).click();

  await expect(page.getByText("local dev")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
