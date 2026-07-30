import { describe, expect, it } from "vitest";
import { createSettingsExport, parseSettingsImport } from "./settings-transfer";

describe("settings transfer", () => {
  it("never exports credentials or PouchDB metadata", () => {
    const output = createSettingsExport({
      theme: "hacker-green",
      serverUrl: "https://example.test",
      serverPassword: "server-secret",
      serverToken: "token-secret",
      couchPassword: "couch-secret",
      rabbitPassword: "rabbit-secret",
      _id: "settings",
      _rev: "1-a"
    });

    expect(output.settings).toEqual({
      theme: "hacker-green",
      serverUrl: "https://example.test"
    });
    expect(JSON.stringify(output)).not.toContain("secret");
  });

  it("accepts a versioned Quasar settings file", () => {
    expect(
      parseSettingsImport(
        JSON.stringify({
          type: "quasar-settings",
          version: 1,
          settings: { theme: "paper", serverToken: "drop-me" }
        })
      )
    ).toEqual({ theme: "paper" });
  });

  it("rejects unrelated JSON", () => {
    expect(() => parseSettingsImport("{}")).toThrow("unsupported settings file");
  });
});
