import { test, expect } from "@playwright/test";

declare global {
  interface Window {
    geoHarness: {
      calls: { command: string; payload: Record<string, unknown> }[];
      defer: boolean;
      pending: (() => void)[];
      denied: boolean;
      revision: number;
    };
  }
}

test("cluster to paged points, canonical evidence and related-document navigation", async ({
  page
}, testInfo) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:5198")) external.push(request.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "105 direct anchors in cell; zoom in" })
  ).toBeVisible();
  await page.getByRole("button", { name: "105 direct anchors in cell; zoom in" }).click();
  await page.getByRole("button", { name: "Select point:1", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open document", exact: true })).toHaveAttribute(
    "href",
    "/documents/point%3A1"
  );
  await page.getByRole("button", { name: "report:1", exact: true }).click();
  await expect(
    page.getByText("Anchored through explicit relations", { exact: true })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Inspect evidence" })).toHaveAttribute(
    "href",
    "/documents/relation%3A1"
  );
  await expect(page.getByRole("link", { name: "Open graph" })).toHaveAttribute(
    "href",
    "/graph?node=report%3A1&review=all"
  );
  await expect(page).toHaveURL(/anchor=report%3A1/);
  await expect(page.getByRole("status")).toContainText("revision 1");
  await page.screenshot({ path: testInfo.outputPath("geo-investigation.png"), fullPage: true });
  await page.getByRole("button", { name: "Next point page" }).click();
  await expect(page.getByRole("button", { name: "Select point:2", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next point page" })).toHaveCount(0);
  expect(external).toEqual([]);
  const calls = await page.evaluate(() => window.geoHarness.calls);
  expect(calls.some((call) => ["document.list", "workspace.snapshot"].includes(call.command))).toBe(
    false
  );
});

test("late locate cannot override point selection or manual pan; repeated lookup works", async ({
  page
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Individual points" }).click();
  await expect(page.getByRole("button", { name: "Select point:1", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.geoHarness.defer = true;
  });
  await page.getByLabel("Find document on map").fill("delayed:A");
  await page.getByRole("button", { name: "Locate", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.geoHarness.pending.length)).toBe(1);
  await page.getByRole("button", { name: "Select point:1", exact: true }).click();
  await page.evaluate(() => {
    window.geoHarness.defer = false;
    window.geoHarness.pending.splice(0).forEach((resolve) => resolve());
  });
  await expect(page.getByRole("link", { name: "Open document", exact: true })).toHaveAttribute(
    "href",
    "/documents/point%3A1"
  );
  await expect(page).not.toHaveURL(/anchor=/);
  await page.getByRole("button", { name: "Locate", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open document", exact: true })).toHaveAttribute(
    "href",
    "/documents/delayed%3AA"
  );
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open document", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Locate", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open document", exact: true })).toHaveAttribute(
    "href",
    "/documents/delayed%3AA"
  );
});

test("local OSM tile requests, mobile layout and denied reads", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const tileRequests: string[] = [];
  await page.route("**/test-tiles/**", async (route) => {
    tileRequests.push(route.request().url());
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#1b3039"/><path d="M0 90H256M100 0V256" stroke="#50636d" stroke-width="8"/></svg>'
    });
  });
  await page.goto("/?tiles");
  await expect.poll(() => tileRequests.length).toBeGreaterThan(0);
  expect(
    tileRequests.every((url) =>
      /^http:\/\/127\.0\.0\.1:5198\/test-tiles\/\d+\/\d+\/\d+\.png$/.test(url)
    )
  ).toBe(true);
  await expect(page.getByRole("link", { name: "© OpenStreetMap contributors" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("revision 1");
  await page.screenshot({ path: testInfo.outputPath("geo-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => {
    window.geoHarness.denied = true;
  });
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Geo access denied");
  await expect(
    page.getByRole("button", { name: "105 direct anchors in cell; zoom in" })
  ).toHaveCount(0);
});
