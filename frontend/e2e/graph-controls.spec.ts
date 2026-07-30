import { expect, test, type Locator, type Page } from "@playwright/test";

type Point = { x: number; y: number };
type GraphSnapshot = {
  node: Point;
  pan: Point;
  zoom: number;
};

async function graphSnapshot(canvas: Locator): Promise<GraphSnapshot> {
  return canvas.evaluate((element) => {
    const graphElement = element as HTMLElement & {
      __quasarGraphAdapter?: {
        nodes: () => {
          first: () => { length: number; renderedPosition: () => { x: number; y: number } };
        };
        pan: () => { x: number; y: number };
        zoom: () => number;
      };
    };
    const cy = graphElement.__quasarGraphAdapter;
    if (!cy) throw new Error("Development graph adapter is unavailable");
    const node = cy.nodes().first();
    if (!node.length) throw new Error("Graph node is unavailable");
    return {
      node: node.renderedPosition(),
      pan: cy.pan(),
      zoom: cy.zoom()
    };
  });
}

function backgroundPoint(node: Point, width: number, height: number): Point {
  const horizontalInset = Math.min(180, Math.max(100, width / 3));
  return {
    x: node.x < width / 2 ? width - horizontalInset : horizontalInset,
    y: height - 80
  };
}

function absolutePoint(origin: Point, point: Point): Point {
  return { x: origin.x + point.x, y: origin.y + point.y };
}

async function clickGraphPoint(
  page: Page,
  origin: Point,
  point: Point,
  button: "left" | "right" = "left"
) {
  const absolute = absolutePoint(origin, point);
  await page.mouse.click(absolute.x, absolute.y, { button });
}

test("uses left click select, left drag pan, and right drag box select", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/graph");

  const suffix = Date.now().toString(36);
  const stage = page.locator(".graph-stage");
  const canvas = page.locator(".graph-canvas");
  await stage.click({ button: "right", position: { x: 220, y: 220 } });
  await page.getByRole("button", { name: "Create person here" }).click();

  const editor = page.getByRole("dialog", { name: "New Person" });
  await editor.getByLabel(/^First Name/).fill(`Control-${suffix}`);
  await editor.getByLabel(/^Last Name/).fill(`Test-${suffix}`);
  await editor.getByLabel(/^Display Name/).fill(`Control Test ${suffix}`);
  await editor.getByRole("button", { name: "Save" }).click();

  const selectionHeading = page.locator(".graph-inspector h2").first();
  await expect(page.locator(".graph-count")).toContainText("nodes");
  await expect(selectionHeading).toContainText("1");

  const dismissNotice = page.getByRole("button", { name: "Dismiss notification" });
  if (await dismissNotice.isVisible()) await dismissNotice.click();

  await page.getByRole("button", { name: "Focus selection" }).click();
  await page.waitForTimeout(400);

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const width = bounds?.width || 0;
  const height = bounds?.height || 0;
  const origin = { x: bounds?.x || 0, y: bounds?.y || 0 };

  const beforeZoom = await graphSnapshot(canvas);
  const zoomTarget = absolutePoint(origin, beforeZoom.node);
  await page.mouse.move(zoomTarget.x, zoomTarget.y);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(200);
  const afterZoom = await graphSnapshot(canvas);
  expect(afterZoom.zoom).toBeLessThan(beforeZoom.zoom);
  await page.waitForTimeout(500);
  const settledZoom = await graphSnapshot(canvas);
  expect(settledZoom.zoom).toBeCloseTo(afterZoom.zoom, 5);

  let background = backgroundPoint(settledZoom.node, width, height);
  await clickGraphPoint(page, origin, background);
  await expect(selectionHeading).toContainText("0");

  const nodeAfterBackground = await graphSnapshot(canvas);
  await clickGraphPoint(page, origin, nodeAfterBackground.node);
  await expect(selectionHeading).toContainText("1");

  const nodeBeforePan = await graphSnapshot(canvas);
  background = backgroundPoint(nodeBeforePan.node, width, height);
  await clickGraphPoint(page, origin, background);
  await expect(selectionHeading).toContainText("0");

  const beforePan = await graphSnapshot(canvas);
  const panStart =
    beforePan.node.x >= width / 2
      ? { x: 180, y: height - 170 }
      : { x: width - 180, y: height - 170 };
  const panEnd =
    beforePan.node.x >= width / 2 ? { x: 480, y: height - 50 } : { x: width - 480, y: height - 50 };
  const expectedShift = {
    x: panEnd.x - panStart.x,
    y: panEnd.y - panStart.y
  };

  const absolutePanStart = absolutePoint(origin, panStart);
  const absolutePanEnd = absolutePoint(origin, panEnd);
  await page.mouse.move(absolutePanStart.x, absolutePanStart.y);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(absolutePanEnd.x, absolutePanEnd.y, { steps: 12 });
  await page.mouse.up({ button: "left" });
  await page.waitForTimeout(500);

  const afterPan = await graphSnapshot(canvas);
  expect(afterPan.pan.x - beforePan.pan.x).toBeCloseTo(expectedShift.x, 0);
  expect(afterPan.pan.y - beforePan.pan.y).toBeCloseTo(expectedShift.y, 0);
  expect(afterPan.node.x - beforePan.node.x).toBeCloseTo(expectedShift.x, 0);
  expect(afterPan.node.y - beforePan.node.y).toBeCloseTo(expectedShift.y, 0);

  background = backgroundPoint(afterPan.node, width, height);
  await clickGraphPoint(page, origin, background, "right");
  await expect(page.getByRole("menu", { name: "canvas actions" })).toBeVisible();
  await page.keyboard.press("Escape");

  const currentNode = await graphSnapshot(canvas);
  await clickGraphPoint(page, origin, currentNode.node, "right");
  await expect(page.getByRole("menu", { name: "node actions" })).toBeVisible();
  await expect(selectionHeading).toContainText("1");
  await page.keyboard.press("Escape");

  const nodeBeforeBox = await graphSnapshot(canvas);
  background = backgroundPoint(nodeBeforeBox.node, width, height);
  await clickGraphPoint(page, origin, background);
  await expect(selectionHeading).toContainText("0");

  const boxStart = {
    x: Math.max(5, nodeBeforeBox.node.x - 70),
    y: Math.max(5, nodeBeforeBox.node.y - 70)
  };
  const boxEnd = {
    x: Math.min(width - 5, nodeBeforeBox.node.x + 70),
    y: Math.min(height - 5, nodeBeforeBox.node.y + 70)
  };
  const absoluteBoxStart = absolutePoint(origin, boxStart);
  const absoluteBoxEnd = absolutePoint(origin, boxEnd);
  await page.mouse.move(absoluteBoxStart.x, absoluteBoxStart.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(absoluteBoxEnd.x, absoluteBoxEnd.y, { steps: 10 });
  await page.mouse.up({ button: "right" });

  await expect(selectionHeading).toContainText("1");
  await expect(page.locator(".graph-context-menu")).toBeHidden();
});
