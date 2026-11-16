import { describe, expect, it, vi } from "vitest";
import {
  discoverProIntegration,
  normalizeProIntegrationMode,
  proIntegrationView
} from "./pro-integration";
import { PRO_ACTOR_MANIFEST_CAPABILITY, PRO_ACTOR_SUBMIT_CAPABILITY } from "./pro-actors";

const grants = [PRO_ACTOR_MANIFEST_CAPABILITY, PRO_ACTOR_SUBMIT_CAPABILITY];
describe("Pro integration preference and authoritative discovery", () => {
  it.each([undefined, null, "invalid", true])("defaults %s to Auto", (value) => {
    expect(normalizeProIntegrationMode(value)).toBe("auto");
  });
  it.each([[], [grants[0]], [grants[1]], null])(
    "does not infer access from incomplete grants %j",
    async (capabilities) => {
      const manifests = vi.fn();
      const result = await discoverProIntegration(async () => capabilities, manifests);
      expect(result.status).toBe("unavailable");
      expect(manifests).not.toHaveBeenCalled();
      expect(proIntegrationView("auto", true, result).visible).toBe(false);
      expect(proIntegrationView("on", true, result)).toMatchObject({
        visible: true,
        canSubmit: false
      });
    }
  );
  it("requires working integration support even with grants (missing plugin/old host)", async () => {
    const result = await discoverProIntegration(
      async () => grants,
      async () => {
        throw new Error("protocol.unknown-command");
      }
    );
    expect(proIntegrationView("auto", true, result).visible).toBe(false);
    expect(proIntegrationView("on", true, result)).toMatchObject({
      visible: true,
      canSubmit: false,
      error: "protocol.unknown-command"
    });
  });
  it("shows an entitled supported host even before manifests are published", async () => {
    const result = await discoverProIntegration(
      async () => grants,
      async () => []
    );
    expect(proIntegrationView("auto", true, result)).toMatchObject({
      visible: true,
      available: true
    });
    expect(proIntegrationView("off", true, result)).toMatchObject({
      visible: false,
      canSubmit: false,
      manifests: []
    });
    expect(proIntegrationView("auto", false, result)).toMatchObject({
      visible: false,
      canSubmit: false
    });
  });
  it("fails closed on unknown entitlement, offline/error and malformed discovery", async () => {
    for (const result of [
      null,
      await discoverProIntegration(async () => {
        throw new Error("offline");
      }, vi.fn()),
      await discoverProIntegration(
        async () => grants,
        async () => null
      )
    ]) {
      expect(proIntegrationView("auto", true, result).canSubmit).toBe(false);
      expect(proIntegrationView("on", false, result)).toMatchObject({
        visible: true,
        canSubmit: false
      });
    }
  });
  it("does not continue discovery after Off, disconnect or unmount", async () => {
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    let current = true;
    const manifests = vi.fn();
    const result = discoverProIntegration(
      () => pending,
      manifests,
      () => current
    );
    current = false;
    release(grants);
    await result;
    expect(manifests).not.toHaveBeenCalled();
  });
});
