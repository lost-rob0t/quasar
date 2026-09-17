import { describe, expect, it } from "vitest";
import { codeRuntime, runCodeBlock } from "../../src/lib/code-block-runner.js";

describe("code block runner", () => {
  it("selects bounded runtimes by language", () => {
    expect(codeRuntime("javascript")).toBe("browser-worker");
    expect(codeRuntime("json")).toBe("json");
    expect(codeRuntime("common-lisp")).toBe("host-sandbox");
    expect(codeRuntime("prolog")).toBe("host-sandbox");
    expect(codeRuntime("bash")).toBeNull();
  });

  it("runs JSON without host execution", async () => {
    const result = await runCodeBlock({ language: "json", source: '{"ok":true}' });
    expect(result.ok).toBe(true);
    expect(result.runtime).toBe("json");
    expect(result.result).toContain('"ok": true');
  });

  it("rejects languages with no sandbox", async () => {
    const result = await runCodeBlock({ language: "bash", source: "echo nope" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("No sandboxed runtime");
  });
});
