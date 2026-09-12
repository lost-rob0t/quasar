import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openCodeStudio(page: Page) {
  await page.goto("/code");
  await expect(page.getByRole("heading", { name: "Code studio" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Common Lisp" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
}

test.describe("Code Studio", () => {
  test("validates Common Lisp live across reader edge cases", async ({ page }) => {
    await openCodeStudio(page);
    const editor = page.getByLabel("Common Lisp source editor");
    const status = page.locator(".code-editor-status").getByRole("status");

    await expect(status).toContainText("Syntax valid");
    await editor.fill('(defun demo () (list #\\( "ok" |escaped(symbol)|)');
    await expect(status).toContainText("Unclosed parenthesis");

    await editor.fill(`(defun demo ()
  #| nested #| block |# comment |#
  (list #\\( "ok" |escaped(symbol)|))`);
    await expect(status).toContainText("Syntax valid");
  });

  test("validates JavaScript without running edited source", async ({ page }) => {
    await openCodeStudio(page);
    await page.getByRole("tab", { name: "JavaScript" }).click();
    const editor = page.getByLabel("JavaScript source editor");
    const status = page.locator(".code-editor-status").getByRole("status");

    await editor.fill("globalThis.__editorProbe = (globalThis.__editorProbe || 0) + 1; const = ;");
    await expect(status).not.toContainText("Syntax valid");
    expect(
      await page.evaluate(
        () => (globalThis as typeof globalThis & { __editorProbe?: number }).__editorProbe
      )
    ).toBeUndefined();

    await editor.fill(
      "globalThis.__editorProbe = (globalThis.__editorProbe || 0) + 1; const answer = 42; void answer;"
    );
    await expect(status).toContainText("Syntax valid");
    expect(
      await page.evaluate(
        () => (globalThis as typeof globalThis & { __editorProbe?: number }).__editorProbe
      )
    ).toBeUndefined();
  });

  test("persists independent Lisp and JavaScript buffers across reload", async ({ page }) => {
    await openCodeStudio(page);
    const lispEditor = page.getByLabel("Common Lisp source editor");
    await lispEditor.fill("(defparameter *persisted* :lisp)");

    await page.getByRole("tab", { name: "JavaScript" }).click();
    const jsEditor = page.getByLabel("JavaScript source editor");
    await jsEditor.fill("const persisted = 'javascript';");

    await page.reload();
    await expect(page.getByLabel("Common Lisp source editor")).toHaveValue(
      "(defparameter *persisted* :lisp)"
    );
    await page.getByRole("tab", { name: "JavaScript" }).click();
    await expect(page.getByLabel("JavaScript source editor")).toHaveValue(
      "const persisted = 'javascript';"
    );
  });

  test("supports keyboard indentation and outdent", async ({ page }) => {
    await openCodeStudio(page);
    const editor = page.getByLabel("Common Lisp source editor");
    await editor.fill("(list 1 2)");
    await editor.focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Tab");
    await expect(editor).toHaveValue("  (list 1 2)");
    await page.keyboard.press("Shift+Tab");
    await expect(editor).toHaveValue("(list 1 2)");
  });

  test("updates line numbers and syntax highlighting while editing", async ({ page }) => {
    await openCodeStudio(page);
    const editor = page.getByLabel("Common Lisp source editor");
    await editor.fill("(defun hello ()\n  42)\n");

    await expect(page.locator(".code-editor-gutter pre")).toContainText("3");
    await expect(page.locator(".code-editor-highlight .tok-keyword")).toContainText("defun");
    await expect(page.locator(".code-editor-highlight .tok-number")).toContainText("42");
    await expect(page.locator(".code-editor-status")).toContainText("3 lines");
  });
});

test.describe("Actor Studio editor integration", () => {
  test("blocks saving invalid JavaScript actor expressions", async ({ page }) => {
    await page.goto("/actors");
    await page
      .getByRole("button", { name: /New actor/ })
      .first()
      .click();
    const sourceEditor = page.getByLabel("JavaScript actor function");

    await sourceEditor.fill("const value = 1;");
    await expect(page.locator(".code-editor-status.invalid")).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".actor-editor-status.error")).toContainText(
      "Invalid JavaScript actor source"
    );

    await sourceEditor.fill(
      "(context) => ({ documents: [], message: String(context.selection.length) })"
    );
    await expect(page.locator(".code-editor-status.valid")).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".actor-editor-status.success")).toContainText("Saved Custom actor");
  });

  test("validates and formats actor manifest JSON", async ({ page }) => {
    await page.goto("/actors");
    await page
      .getByRole("button", { name: /New actor/ })
      .first()
      .click();
    await page.getByRole("button", { name: "config" }).click();
    const manifestEditor = page.getByLabel("Actor manifest JSON");

    await manifestEditor.fill('{"id":');
    await expect(page.locator(".code-editor-status.invalid")).toBeVisible();
    await page.getByRole("button", { name: "Format JSON" }).click();
    await expect(page.locator(".actor-editor-status.error")).toBeVisible();

    await manifestEditor.fill(
      '{"id":"quasar.actor.e2e","label":"E2E actor","description":"test","version":1,"accepts":["*"],"triggers":[],"capabilities":[],"limits":{},"minSelection":1,"maxSelection":1}'
    );
    await expect(page.locator(".code-editor-status.valid")).toBeVisible();
    await page.getByRole("button", { name: "Format JSON" }).click();
    await expect(manifestEditor).toHaveValue(/quasar\.actor\.e2e/);
    await expect(manifestEditor).toHaveValue(/\n  "label": "E2E actor"/);
  });
});
