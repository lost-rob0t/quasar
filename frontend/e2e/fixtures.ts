import { expect, test as base, type Page } from "@playwright/test";

type Fixtures = {
  page: Page;
  crashGuard: boolean;
};

export const test = base.extend<Fixtures>({
  crashGuard: [false, { option: true }],

  // Workspace isolation per test, plus opt-in crash capture: fail the
  // journey when the page throws an uncaught runtime error (the class of
  // live defect behind forgejo #148 and the stale setMenuQuery crash -
  // tsc cannot see .jsx identifier bugs). Journeys opt in with
  // test.use({ crashGuard: true }).
  page: async ({ page, crashGuard }, use, testInfo) => {
    const workspaceId = `e2e-${Date.now()}-${testInfo.workerIndex}-${testInfo.testId.replace(/[^a-z0-9]/gi, "-")}`;
    await page.addInitScript((id) => {
      window.sessionStorage.setItem("quasar-workspace", id);
    }, workspaceId);

    const crashes: string[] = [];
    if (crashGuard) {
      page.on("pageerror", (error) => crashes.push(String(error)));
    }
    await use(page);
    if (crashGuard && crashes.length) {
      throw new Error(`uncaught page errors on ${testInfo.title}: ${crashes.join(" | ")}`);
    }
  }
});

export { expect };
