import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CodeWorkbench from "./CodeWorkbench";

describe("CodeWorkbench", () => {
  it("renders a highlighted validated Lisp editor and language switcher", () => {
    const html = renderToStaticMarkup(<CodeWorkbench />);

    expect(html).toContain("Code studio");
    expect(html).toContain("Common Lisp");
    expect(html).toContain("JavaScript");
    expect(html).toContain("Syntax valid");
    expect(html).toContain("code-editor-highlight");
    expect(html).toContain("tok-keyword");
    expect(html).toContain("Autosaved locally");
  });
});
