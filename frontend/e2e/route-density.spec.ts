import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";

const ROUTES = [
  { slug: "home", path: "/" },
  { slug: "graph", path: "/graph" },
  { slug: "datasets", path: "/datasets" },
  { slug: "documents", path: "/documents" },
  { slug: "document-new", path: "/documents/new" },
  { slug: "agents", path: "/agents" },
  { slug: "actors", path: "/actors" },
  { slug: "code", path: "/code" },
  { slug: "import", path: "/import" },
  { slug: "settings", path: "/settings" }
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 }
] as const;

const CORE_RESOURCE_TYPES = new Set(["document", "script", "stylesheet"]);

async function captureEvidence(
  page: Parameters<typeof test>[0] extends never ? never : any,
  viewportName: string,
  routeSlug: string
) {
  if (process.env.PR_VISUAL_EVIDENCE !== "1") return;
  const outputDir = process.env.PR_SCREENSHOT_DIR || "pr-screenshots";
  await mkdir(outputDir, { recursive: true });
  await page.screenshot({
    path: path.join(outputDir, `${viewportName}-${routeSlug}.png`),
    fullPage: true,
    animations: "disabled"
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} primary-route contract`, () => {
    for (const route of ROUTES) {
      test(`${route.path} renders cleanly and stays inside the viewport`, async ({ page }) => {
        const pageErrors: string[] = [];
        const failedCoreRequests: string[] = [];

        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("requestfailed", (request) => {
          if (CORE_RESOURCE_TYPES.has(request.resourceType())) {
            failedCoreRequests.push(`${request.resourceType()}: ${request.url()}`);
          }
        });

        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(route.path, { waitUntil: "domcontentloaded" });

        await expect(page).toHaveTitle("Quasar");
        await expect(page.locator("main")).toBeVisible();
        await expect(page.locator(".loading-panel")).toHaveCount(0);
        await expect(page.getByText("Route not found", { exact: true })).toHaveCount(0);

        const geometry = await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          main: document.querySelector("main")?.getBoundingClientRect().toJSON() || null
        }));

        expect(geometry.main).not.toBeNull();
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);

        if (viewport.name === "desktop") {
          await expect(page.locator(".quasar-shell > .sidebar")).toBeVisible();
          const activeHref = route.path === "/" ? "/" : route.path;
          await expect(page.locator(`.sidebar a.nav-link.active[href="${activeHref}"]`)).toHaveCount(1);
        } else {
          await expect(page.locator(".quasar-shell > .sidebar")).toBeHidden();
          await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
        }

        await page.addStyleTag({
          content:
            "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}"
        });
        await captureEvidence(page, viewport.name, route.slug);

        expect(pageErrors).toEqual([]);
        expect(failedCoreRequests).toEqual([]);
      });
    }
  });
}
