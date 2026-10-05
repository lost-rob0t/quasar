import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

type StartupWindow = Window & { quasarStartupErrors?: string[] };

export async function observeStartupErrors(page: Page) {
  await page.addInitScript(() => {
    const errors: string[] = [];
    (window as StartupWindow).quasarStartupErrors = errors;
    new MutationObserver(() => {
      for (const notice of document.querySelectorAll(".notice-error")) {
        const message = notice.textContent || "Unknown startup error";
        if (!errors.includes(message)) errors.push(message);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
}

export async function expectCleanStartup(page: Page) {
  // A rendered route alone can precede the asynchronous view installation.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const dbModule = "/src/lib/db.js";
        const viewsModule = "/src/lib/views.js";
        const { documentsDb } = await import(/* @vite-ignore */ dbModule);
        const { STARINTEL_VIEW_MANIFEST } = await import(/* @vite-ignore */ viewsModule);
        const result = await documentsDb.allDocs({
          keys: STARINTEL_VIEW_MANIFEST.map((entry: { id: string }) => entry.id),
          include_docs: true
        });
        return result.rows.every(
          (row: { doc?: { quasar_view_version: number; views: object } }, index: number) =>
            row.doc?.quasar_view_version === STARINTEL_VIEW_MANIFEST[index].version &&
            JSON.stringify(row.doc?.views) === JSON.stringify(STARINTEL_VIEW_MANIFEST[index].views)
        );
      })
    )
    .toBe(true);
  // Let React commit notices from the completed database promises before capture.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await expect(page.locator(".notice-error")).toHaveCount(0);
  expect(await page.evaluate(() => (window as StartupWindow).quasarStartupErrors)).toEqual([]);
}
