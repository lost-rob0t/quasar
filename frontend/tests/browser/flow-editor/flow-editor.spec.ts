import { expect, test, type Page } from "@playwright/test";
import { exampleFlow } from "../../../src/flows/validation";
import type { Flow } from "../../../src/flows/model";
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});
async function importFlow(page: Page, flow: Flow) {
  await page.getByText("Import / export flow JSON", { exact: true }).click();
  await page.getByLabel("Flow JSON", { exact: true }).fill(JSON.stringify(flow));
  await page.getByRole("button", { name: "Import JSON", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText("Flow imported");
}
test("authors, wires, validates, persists and previews a graph", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Flow studio", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run preview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Preview completed" })).toBeVisible();
  await expect(page.getByLabel("Preview results")).toContainText("6");
  await page.getByRole("button", { name: "Multiply by 2 map", exact: true }).click();
  await page
    .getByLabel("Configuration JSON", { exact: true })
    .fill('{"operation":"multiply","path":"","value":3}');
  await expect(page.getByRole("button", { name: "Run preview" })).toBeDisabled();
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page.getByRole("button", { name: "Save flow" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Run preview" }).click();
  await expect(page.getByRole("heading", { name: "Preview completed" })).toBeVisible();
  await page.getByRole("button", { name: "Multiply by 2 map", exact: true }).click();
  const title = page.getByRole("button", { name: "Multiply by 2 map", exact: true });
  await title.scrollIntoViewIfNeeded();
  const box = await title.boundingBox();
  if (!box) throw new Error("Missing node bounds");
  await page.mouse.move(box.x + 70, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + 35, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByLabel("X", { exact: true })).toHaveValue("330");
  await page.getByLabel("X", { exact: true }).fill("400");
  await expect(page.getByLabel("X", { exact: true })).toHaveValue("400");
  const flow = exampleFlow();
  flow.edges = [];
  await importFlow(page, flow);
  await page.getByLabel("From output").selectOption(JSON.stringify({ node: "input", port: "out" }));
  await page.getByLabel("To input").selectOption(JSON.stringify({ node: "double", port: "in" }));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText("Connection added");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText("Duplicate connection");
  await page
    .getByLabel("From output")
    .selectOption(JSON.stringify({ node: "double", port: "out" }));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText("acyclic");
  await page.screenshot({ path: testInfo.outputPath("flow-desktop.png"), fullPage: true });
});
test("isolates JavaScript, handles errors and enforces timeout", async ({ page }) => {
  await page.goto("/");
  const flow = exampleFlow();
  flow.nodes = [
    flow.nodes[0],
    {
      ...flow.nodes[1],
      type: "code.javascript",
      config: { source: "(payload) => ({payload, network: typeof fetch})" }
    },
    flow.nodes[3]
  ];
  flow.edges = [
    flow.edges[0],
    { id: "result", from: { node: "double", port: "out" }, to: { node: "output", port: "in" } }
  ];
  await importFlow(page, flow);
  await page.getByRole("button", { name: "Run preview" }).click();
  await expect(page.getByRole("alert")).toContainText("disabled");
  await page.getByLabel("Enable isolated JavaScript", { exact: false }).check();
  await page.getByRole("button", { name: "Run preview" }).click();
  await expect(page.getByRole("heading", { name: "Preview completed" })).toBeVisible();
  await expect(page.getByLabel("Preview results")).toContainText('"network": "undefined"');
  expect(await page.locator('iframe[sandbox="allow-scripts"]').count()).toBe(0);
  await page.getByRole("button", { name: "Multiply by 2 code.javascript", exact: true }).click();
  await page.getByLabel("Node source", { exact: true }).fill("() => { while(true) {} }");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page.getByRole("button", { name: "Run preview" }).click();
  await expect(page.getByRole("alert")).toContainText("timed out", { timeout: 8000 });
  expect(await page.locator('iframe[sandbox="allow-scripts"]').count()).toBe(0);
  await page
    .getByLabel("Configuration JSON")
    .fill(JSON.stringify({ source: "() => { throw new Error('fixture failed') }" }));
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page.getByRole("button", { name: "Run preview" }).click();
  await expect(page.getByRole("alert")).toContainText("fixture failed");
});
test("edits on mobile without page overflow and preserves invalid imports", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Find nodes").fill("RabbitMQ");
  await page.getByRole("button", { name: "RabbitMQ Transport · adapter" }).click();
  await expect(page.getByLabel("Node inspector")).toContainText("Disabled without");
  await expect(page.getByRole("button", { name: "Run preview" })).toBeDisabled();
  await page.getByRole("button", { name: "Delete node" }).click();
  await page.getByText("Import / export flow JSON", { exact: true }).click();
  await page.getByLabel("Flow JSON", { exact: true }).fill('{"version":99}');
  await page.getByRole("button", { name: "Import JSON", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText("Import failed");
  await expect(page.getByLabel("Flow name")).toHaveValue("Map and filter preview");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: testInfo.outputPath("flow-mobile.png"), fullPage: true });
});
