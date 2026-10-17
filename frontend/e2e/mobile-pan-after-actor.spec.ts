import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

type Point = { x: number; y: number };
type GraphState = { node: Point; pan: Point };

async function seedUsernameActorOutput(page: Page): Promise<string> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/control-plane/client.ts";
        return (await import(path)).getControlPlane()?.getConnected();
      })
    )
    .toBe(true);
  const { sourceId, graphId } = await page.evaluate(async () => {
    const path = "/src/control-plane/client.ts";
    const client = (await import(path)).getControlPlane();
    const suffix = Date.now().toString(36),
      sourceId = `person:pan-${suffix}`,
      graphId = `pan-${suffix}`;
    const documents: Record<string, unknown>[] = [
      { id: sourceId, dtype: "person", fullName: "Andrew Tyler Meek" }
    ];
    const positions: Record<string, { x: number; y: number }> = { [sourceId]: { x: 195, y: 300 } };
    for (let index = 0; index < 8; index += 1) {
      const id = `entity:pan-${suffix}-${index}`;
      documents.push({ id, dtype: "entity", name: `@candidate${index}` });
      documents.push({
        id: `relation:pan-${suffix}-${index}`,
        dtype: "relation",
        source: { schema: "org.starintel/core@1/document", id: sourceId },
        destination: { schema: "org.starintel/core@1/document", id },
        predicate: "may-use-username"
      });
      positions[id] = {
        x: 195 + Math.cos((index / 8) * Math.PI * 2) * 105,
        y: 300 + Math.sin((index / 8) * Math.PI * 2) * 105
      };
    }
    await client.transaction([
      ...documents.map((payload) => ({
        type: "document.create",
        payload: {
          ...payload,
          dataset: "pan-fixture",
          schemaVersion: "0.10.1",
          extensions: { quasarLegacy090: { verification: { verified: true } } }
        }
      })),
      {
        type: "graph.put",
        payload: {
          id: graphId,
          name: "Pan actor output",
          documentIds: documents.map((doc) => doc.id),
          positions,
          selectedIds: [sourceId],
          layout: "preset"
        }
      }
    ]);
    return { sourceId, graphId };
  });
  await expect(
    page.getByLabel("Open graph", { exact: true }).locator(`option[value="${graphId}"]`)
  ).toHaveCount(1);
  await page.getByLabel("Open graph", { exact: true }).selectOption(graphId);
  await expect
    .poll(async () => (await graphState(page.locator(".graph-canvas"), sourceId)).node)
    .toBeTruthy();
  return sourceId;
}

async function graphState(canvas: Locator, nodeId: string): Promise<GraphState> {
  return canvas.evaluate((element, id) => {
    const graphElement = element as HTMLElement & {
      __quasarGraphAdapter?: {
        getElementById: (nodeId: string) => {
          renderedPosition: () => Point;
        };
        pan: () => Point;
      };
    };
    const cy = graphElement.__quasarGraphAdapter;
    if (!cy) throw new Error("Development graph adapter is unavailable");
    return {
      node: cy.getElementById(id).renderedPosition(),
      pan: cy.pan()
    };
  }, nodeId);
}

test("mobile pan remains authoritative after username actor output", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/graph");

  const canvas = page.locator(".graph-canvas");
  await expect(canvas).toBeVisible();
  const sourceId = await seedUsernameActorOutput(page);
  const before = await graphState(canvas, sourceId);

  await canvas.evaluate((element) => {
    const graphElement = element as HTMLElement & {
      __quasarGraphAdapter?: {
        emit: (event: string) => void;
      };
    };
    graphElement.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        isPrimary: true,
        pointerId: 41,
        pointerType: "touch"
      })
    );
    graphElement.__quasarGraphAdapter?.emit("dragpan");
  });

  await page.waitForTimeout(500);
  await canvas.evaluate((element) => {
    const graphElement = element as HTMLElement & {
      __quasarGraphAdapter?: {
        panBy: (shift: Point) => void;
      };
    };
    graphElement.__quasarGraphAdapter?.panBy({ x: -280, y: 0 });
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        isPrimary: true,
        pointerId: 41,
        pointerType: "touch"
      })
    );
  });

  await page.waitForTimeout(700);
  const after = await graphState(canvas, sourceId);

  expect(after.pan.x - before.pan.x).toBeCloseTo(-280, 0);
  expect(after.pan.y - before.pan.y).toBeCloseTo(0, 0);
  expect(after.node.x - before.node.x).toBeCloseTo(-280, 0);
  expect(after.node.y - before.node.y).toBeCloseTo(0, 0);
});
