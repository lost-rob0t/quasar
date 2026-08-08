import { describe, expect, it } from "vitest";
import { redactDiagnostic } from "./runtime-diagnostics";

describe("runtime diagnostics", () => {
  it("redacts credentials without removing useful stack context", () => {
    const diagnostic = redactDiagnostic(
      "TypeError at https://alice:hunter2@example.test/path?token=abc123&api_key=xyz password=hidden\n    at GraphPage:42"
    );

    expect(diagnostic).toContain("TypeError");
    expect(diagnostic).toContain("GraphPage:42");
    expect(diagnostic).not.toMatch(/alice|hunter2|abc123|xyz|hidden/);
    expect(diagnostic.match(/\[redacted]/g)).toHaveLength(3);
  });
});
