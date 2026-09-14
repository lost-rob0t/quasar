import { describe, expect, it } from "vitest";
import { probeStarIntelServer } from "../../src/lib/starintel-server";

const serverUrl = process.env.STARINTEL_TEST_URL;
const username = process.env.STARINTEL_TEST_USERNAME;
const password = process.env.STARINTEL_TEST_PASSWORD;
const live = serverUrl && username && password ? describe : describe.skip;

live("live StarIntel HTTP auth contract", () => {
  it("discovers the real server, logs in with known credentials, and resolves context", async () => {
    const result = await probeStarIntelServer({
      serverUrl,
      serverUsername: username,
      serverPassword: password
    });

    expect(result.mode).toBe("v1");
    expect(result.authenticated).toBe(true);
    expect(result.capabilities.authentication.modes).toContain("api-key");
    expect(result.context).toBeTruthy();
  });
});
