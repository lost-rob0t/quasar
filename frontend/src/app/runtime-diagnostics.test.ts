import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeDiagnostics,
  readRuntimeDiagnostics,
  recordRuntimeDiagnostic,
  redactDiagnostic
} from "./runtime-diagnostics";

afterEach(() => clearRuntimeDiagnostics());

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

  it("retains a bounded newest-first history with redacted details", () => {
    for (let index = 0; index < 260; index += 1) {
      recordRuntimeDiagnostic({
        level: "error",
        source: "test",
        message: `failure-${index}`,
        details: `token=secret-${index}`
      });
    }

    const entries = readRuntimeDiagnostics();
    expect(entries).toHaveLength(250);
    expect(entries[0].message).toBe("failure-259");
    expect(entries.at(-1)?.message).toBe("failure-10");
    expect(entries.every((entry) => !entry.details.includes("secret-"))).toBe(true);
  });

  it("deduplicates repeated events while preserving occurrence count", () => {
    recordRuntimeDiagnostic({ source: "control-plane", message: "WebSocket is not connected." });
    recordRuntimeDiagnostic({ source: "control-plane", message: "WebSocket is not connected." });

    const entries = readRuntimeDiagnostics();
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(2);
  });
});
