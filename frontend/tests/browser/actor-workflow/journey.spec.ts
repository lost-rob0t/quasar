import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
let processHandle: ChildProcess;
let directory: string;
let statePath: string;
async function startFixture() {
  processHandle = spawn(
    process.execPath,
    [fileURLToPath(new URL("./server.mjs", import.meta.url)), statePath],
    { stdio: "inherit" }
  );
  await expect
    .poll(
      async () => {
        try {
          return (await fetch("http://127.0.0.1:5191/health")).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15000 }
    )
    .toBe(200);
}
async function stopFixture() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const stopped = new Promise<void>((resolve) => processHandle.once("exit", () => resolve()));
  processHandle.kill("SIGTERM");
  await stopped;
}
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 }
]) {
  test(`synthetic HTTP recovery and exact document handoff at ${viewport.width}px`, async ({
    page,
    context
  }, testInfo) => {
    directory = await mkdtemp(join(tmpdir(), "quasar-actor-fixture-"));
    statePath = join(directory, "state.json");
    await startFixture();
    try {
      await page.setViewportSize(viewport);
      await page.goto("/tests/browser/actor-workflow/");
      await page
        .getByRole("list", { name: "Actors" })
        .getByRole("button", { name: /synthetic/ })
        .click();
      await page.getByLabel("Target input", { exact: true }).fill("fixture.invalid");
      await page.getByLabel("Target dataset", { exact: true }).fill("synthetic");
      await page.getByRole("button", { name: "Submit to server", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Submission outcome unknown");
      await expect(page.getByRole("button", { name: "Retry same submission" })).toBeEnabled({
        timeout: 15000
      });
      let records = JSON.parse(await readFile(statePath, "utf8"));
      const [key] = Object.keys(records);
      expect(Object.keys(records)).toHaveLength(1);
      await context.setOffline(true);
      await page.getByRole("button", { name: "Retry same submission" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await context.setOffline(false);
      // Actual fixture-process restart, retaining only its on-disk acceptance ledger.
      await stopFixture();
      await startFixture();
      await page.reload();
      await page
        .getByRole("list", { name: "Actors" })
        .getByRole("button", { name: /synthetic/ })
        .click();
      await expect(page.getByRole("status")).toContainText("Submission outcome unknown");
      await page.getByRole("button", { name: "Retry same submission" }).click();
      await expect(page.getByRole("status")).toContainText(
        "Server confirmed the existing Target. Execution status is unavailable."
      );
      records = JSON.parse(await readFile(statePath, "utf8"));
      expect(Object.keys(records)).toEqual([key]);
      await page.getByRole("button", { name: "Open server Target", exact: true }).click();
      await expect(page.getByLabel("Server document", { exact: true })).toContainText(
        records[key].receipt.target_id
      );
      await page.getByLabel("Server document ID", { exact: true }).fill("target:synthetic-output");
      await page.getByRole("button", { name: "Open server document", exact: true }).click();
      await expect(page.getByLabel("Server document", { exact: true })).toContainText(
        "synthetic output document"
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("accepted-and-document.png"),
        fullPage: true
      });
      await testInfo.attach("synthetic-acceptance-ledger", {
        path: statePath,
        contentType: "application/json"
      });
      await page.reload();
      await page
        .getByRole("list", { name: "Actors" })
        .getByRole("button", { name: /synthetic/ })
        .click();
      await expect(page.getByRole("status")).toContainText("Execution status is unavailable");
      await expect(page.getByRole("button", { name: "Retry same submission" })).toHaveCount(0);
    } finally {
      await stopFixture();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
