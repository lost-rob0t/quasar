import { expect, test } from "@playwright/test";

test("uses a full-screen graph canvas with three mobile controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/graph");

  await expect(page.locator(".topbar")).toBeHidden();
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".graph-toolbar")).toBeHidden();
  await expect(page.locator(".graph-list-panel")).toBeHidden();
  await expect(page.locator(".graph-inspector")).toBeHidden();
  await expect(page.getByLabel("Dataset filter", { exact: true })).toBeHidden();
  await expect(page.getByLabel("Graph layout", { exact: true })).toBeHidden();
  await expect(page.getByLabel("Maltego graph layout", { exact: true })).toBeHidden();
  await expect(page.getByLabel("Active graph", { exact: true })).toBeHidden();

  await expect(page.getByRole("button", { name: "Graph tools" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add graph document" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import", exact: true })).toBeVisible();
  await expect(page.locator(".graph-mobile-primary-button")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Search graph" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Cycle layout" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Fit graph" })).toBeHidden();

  const centers = await page.locator(".graph-mobile-primary-button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const buttonRect = button.getBoundingClientRect();
      const iconRect = button.querySelector("svg")?.getBoundingClientRect();
      return {
        x: Math.abs(
          buttonRect.left +
            buttonRect.width / 2 -
            ((iconRect?.left || 0) + (iconRect?.width || 0) / 2)
        ),
        y: Math.abs(
          buttonRect.top +
            buttonRect.height / 2 -
            ((iconRect?.top || 0) + (iconRect?.height || 0) / 2)
        )
      };
    })
  );
  for (const center of centers) {
    expect(center.x).toBeLessThanOrEqual(1);
    expect(center.y).toBeLessThanOrEqual(1);
  }

  const emptyActions = page.locator(".graph-empty-state .button-row");
  await expect(emptyActions).toBeVisible();
  await expect(emptyActions).toHaveCSS("display", "grid");
  const emptyStateLayout = await emptyActions.evaluate((row) => {
    const rowRect = row.getBoundingClientRect();
    return {
      rawText: [...row.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim())
        .filter(Boolean),
      buttonCenters: [...row.children].map((button) => {
        const rect = button.getBoundingClientRect();
        return Math.abs(rect.left + rect.width / 2 - (rowRect.left + rowRect.width / 2));
      })
    };
  });
  expect(emptyStateLayout.rawText).toEqual([]);
  for (const offset of emptyStateLayout.buttonCenters) expect(offset).toBeLessThanOrEqual(1);

  const stage = await page.locator(".graph-stage").boundingBox();
  expect(stage).not.toBeNull();
  expect(stage?.x).toBe(0);
  expect(stage?.y).toBe(0);
  expect(stage?.width).toBe(390);
  expect(stage?.height).toBe(844);

  await page.getByRole("button", { name: "Graph tools" }).click();
  const tray = page.getByRole("menu", { name: "Graph tools" });
  await expect(tray).toBeVisible();
  await expect(tray.getByRole("menuitem", { name: "Navigation" })).toBeVisible();
  await expect(tray.getByRole("menuitem", { name: "Search" })).toBeVisible();
  await expect(tray.getByRole("menuitem", { name: "Graph" })).toBeVisible();
  await expect(tray.getByRole("menuitem", { name: "Dataset" })).toBeVisible();
  await expect(tray.getByRole("menuitem", { name: "Layout" })).toBeVisible();
  await expect(tray.getByRole("menuitem", { name: "Fit" })).toBeVisible();
  await expect(tray.getByRole("menuitem", { name: "Focus" })).toBeVisible();
  await expect(tray.getByRole("menuitem", { name: "Labels" })).toBeVisible();
  await expect(tray.getByRole("menuitem", { name: "Remove" })).toBeVisible();

  await tray.getByRole("menuitem", { name: "Search" }).click();
  await expect(page.getByRole("textbox", { name: "Graph search overlay" })).toBeVisible();
  await page.getByRole("textbox", { name: "Graph search overlay" }).fill("Jane");
  await expect(page.locator(".graph-search input")).toHaveValue("Jane");
  await page.getByRole("button", { name: "Close graph search" }).click();

  await expect(page.getByLabel("Maltego graph layout", { exact: true })).toHaveValue("organic");
  await page.getByRole("button", { name: "Graph tools" }).click();
  await page
    .getByRole("menu", { name: "Graph tools" })
    .getByRole("menuitem", { name: "Layout" })
    .click();
  await expect(page.getByLabel("Maltego graph layout", { exact: true })).toHaveValue(
    "interactive-organic"
  );

  await page.locator(".graph-stage").click({ button: "right", position: { x: 180, y: 360 } });
  const radial = page.locator(".graph-context-menu.canvas-actions.radial-root");
  await expect(radial).toBeVisible();
  await expect(radial.getByRole("menuitem", { name: /Create node/ })).toBeVisible();
  await expect(radial.getByRole("menuitem", { name: /Graph/ })).toBeVisible();
  await expect(radial.getByRole("menuitem", { name: /Layout/ })).toBeVisible();
  await expect(radial.getByRole("menuitem", { name: /Ingest/ })).toBeVisible();
});

test("collapses thinking and tool output until expanded", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const log = document.createElement("div");
    log.className = "agent-log";
    log.innerHTML = `
      <article class="agent-log-entry model"><strong>Agent</strong><pre>private reasoning payload</pre></article>
      <article class="agent-log-entry tool"><strong>web_search</strong><pre>tool result payload</pre></article>
    `;
    document.querySelector(".content")?.appendChild(log);
  });

  const thinking = page.getByRole("button", { name: /Agent thinking/ });
  const tool = page.getByRole("button", { name: /web_search/ });
  await expect(thinking).toBeVisible();
  await expect(tool).toBeVisible();
  await expect(page.getByText("private reasoning payload")).toBeHidden();
  await expect(page.getByText("tool result payload")).toBeHidden();

  await thinking.click();
  await expect(page.getByText("private reasoning payload")).toBeVisible();
  await tool.click();
  await expect(page.getByText("tool result payload")).toBeVisible();
});
