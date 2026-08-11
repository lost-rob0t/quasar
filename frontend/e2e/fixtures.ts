import { expect, test as base } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const workspaceId = `e2e-${Date.now()}-${testInfo.workerIndex}-${testInfo.testId.replace(/[^a-z0-9]/gi, "-")}`;
    await page.addInitScript((id) => {
      window.sessionStorage.setItem("quasar-workspace", id);
    }, workspaceId);
    await use(page);
  }
});

export { expect };
