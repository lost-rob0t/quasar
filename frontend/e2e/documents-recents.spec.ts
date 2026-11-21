import { expect, test } from "./fixtures";

test.use({ crashGuard: true });
import { STAR_SERVER_URL, configureStarServer, starServerAvailable } from "./helpers";

// Operator journey (forgejo #142, verified live 2026-11-20): with an empty
// search box the Documents view shows server recents under the
// "recent ingest" divider, paged by a key cursor via "Load more".
test("empty query lists server recents and pages by cursor", async ({ page }) => {
  test.skip(!(await starServerAvailable()), "live star-server not reachable");

  // The recents UI can only render what the server view has indexed; if the
  // index is mid-rebuild (post-deploy) there is nothing to assert yet.
  const probe = await fetch(`${STAR_SERVER_URL}/documents/recent?limit=1`, {
    signal: AbortSignal.timeout(8000)
  });
  const total = probe.ok ? ((await probe.json())?.total_rows ?? 0) : 0;
  test.skip(total <= 0, `server recents index empty (total_rows=${total})`);

  await configureStarServer(page);
  await page.goto("/documents");

  const search = page.locator('input[type="search"], input[placeholder*="earch"]').first();
  await search.fill("");
  await page.waitForTimeout(1500);

  const divider = page.locator(".server-divider-label").first();
  await expect(divider).toBeVisible();
  await expect(divider).toContainText("recent ingest");

  const rows = page.locator("tr.server-row");
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();

  // Cursor paging: only assert growth when the corpus exceeds one page;
  // otherwise a complete page with no cursor is the correct outcome.
  const loadMore = page.locator("tr.server-more-row button").first();
  if (total > before) {
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(before);
  } else {
    expect(before).toBeGreaterThan(0);
  }
});
