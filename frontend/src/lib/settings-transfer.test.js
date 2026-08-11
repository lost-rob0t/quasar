import { describe, expect, it } from "vitest";
import { createSettingsExport, parseSettingsImport } from "./settings-transfer";

describe("settings transfer", () => {
  it("never exports credentials or PouchDB metadata", () => {
    const output = createSettingsExport({
      theme: "hacker-green",
      serverUrl: "https://example.test",
      serverUsername: "server-user",
      serverPassword: "server-secret",
      serverToken: "token-secret",
      couchPassword: "couch-secret",
      rabbitPassword: "rabbit-secret",
      provider: { apiKey: "nested-secret", model: "test-model" },
      remoteUrl: "https://embedded:credential@example.test/path?token=query-secret&view=safe",
      _id: "settings",
      _rev: "1-a"
    });

    expect(output.settings).toEqual({
      theme: "hacker-green",
      serverUrl: "https://example.test/",
      provider: { model: "test-model" },
      remoteUrl: "https://example.test/path?view=safe"
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
