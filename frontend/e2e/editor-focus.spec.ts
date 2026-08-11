import { expect, test } from "./fixtures";

test("keeps focus in the edited field after the first character marks the graph editor dirty", async ({
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/graph");

  const stage = page.locator(".graph-stage");
  await stage.click({ button: "right", position: { x: 220, y: 220 } });
  await page.getByRole("button", { name: "Create person here" }).click();

  const editor = page.getByRole("dialog", { name: "New Person" });
  const firstName = editor.getByLabel(/^First Name/);

  await firstName.focus();
  await page.keyboard.type("A");

  await expect(firstName).toHaveValue("A");
  await expect(firstName).toBeFocused();

  await page.keyboard.type("lice");

  await expect(firstName).toHaveValue("Alice");
  await expect(firstName).toBeFocused();
  await expect(editor.getByRole("button", { name: "Close" })).not.toBeFocused();
});
