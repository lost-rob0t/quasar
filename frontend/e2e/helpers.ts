import type { Page } from "@playwright/test";

const STAR_SERVER_URL = process.env.STAR_SERVER_URL || "http://127.0.0.1:5000";

export { STAR_SERVER_URL };

// True when the local star-server answers /health. Tests that depend on the
// live ingest stack skip cleanly when it is absent (Forgejo CI has no CouchDB
// corpus; the operator's desktop stack does).
export async function starServerAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${STAR_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(3000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Configure the active StarIntel server through Settings, the way an
// operator does. The form resets when the async settings load lands
// (useEffect setForm(settings) on settings identity), so fill only after the
// load settles and verify the value stuck before saving.
export async function configureStarServer(page: Page, url = STAR_SERVER_URL): Promise<void> {
  await page.goto("/settings");
  const urlInput = page.getByPlaceholder("http://localhost:5000");
  await urlInput.waitFor({ state: "visible" });
  await page.waitForTimeout(2500);
  await urlInput.fill(url);
  await page.waitForTimeout(500);
  if ((await urlInput.inputValue()) !== url) await urlInput.fill(url);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expectSaved(page, url);
}

async function expectSaved(page: Page, url: string): Promise<void> {
  await page.waitForTimeout(800);
  await page.reload({ waitUntil: "networkidle" });
  const persisted = page.getByPlaceholder("http://localhost:5000");
  await persisted.waitFor({ state: "visible" });
  await page.waitForTimeout(1000);
  const value = await persisted.inputValue();
  if (value !== url) {
    throw new Error(`server URL did not persist (got ${JSON.stringify(value)})`);
  }
}
