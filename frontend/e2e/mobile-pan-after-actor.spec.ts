import { expect, test, type Locator } from "@playwright/test";

type Point = { x: number; y: number };
type GraphState = { node: Point; pan: Point };

async function seedUsernameActorOutput(canvas: Locator): Promise<string> {
  return canvas.evaluate((element) => {
    const graphElement = element as HTMLElement & {
      __quasarGraphAdapter?: {
        add: (elements: unknown[]) => void;
        getElementById: (id: string) => {
          select: () => void;
        };
      };
    };
    const cy = graphElement.__quasarGraphAdapter;
    if (!cy) throw new Error("Development graph adapter is unavailable");

    const suffix = Date.now().toString(36);
    const sourceId = `mobile-pan-person-${suffix}`;
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      id: `mobile-pan-username-${suffix}-${index}`,
      label: `@candidate${index}`,
      position: {
        x: 195 + Math.cos((index / 8) * Math.PI * 2) * 105,
        y: 300 + Math.sin((index / 8) * Math.PI * 2) * 105
      }
    }));

    cy.add([
      {
        group: "nodes",
        data: { id: sourceId, label: "Andrew Tyler Meek", dtype: "person" },
        position: { x: 195, y: 300 }
      },
      ...candidates.map((candidate) => ({
        group: "nodes",
        data: { id: candidate.id, label: candidate.label, dtype: "entity" },
        position: candidate.position
      })),
      ...candidates.map((candidate) => ({
        group: "edges",
        data: {
          id: `${sourceId}-may-use-${candidate.id}`,
          source: sourceId,
          target: candidate.id,
          predicate: "may-use-username"
        }
      }))
    ]);
    cy.getElementById(sourceId).select();
    return sourceId;
  });
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
  const sourceId = await seedUsernameActorOutput(canvas);
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
