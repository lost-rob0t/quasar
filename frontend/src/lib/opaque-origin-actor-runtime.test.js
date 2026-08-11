import { describe, expect, it } from "vitest";
import {
  OPAQUE_ORIGIN_ACTOR_SANDBOX,
  OPAQUE_ORIGIN_SANDBOX_TOKENS,
  buildOpaqueOriginActorFrameSource
} from "./opaque-origin-actor-runtime";

describe("opaque-origin actor runtime", () => {
  it("uses script-only sandbox tokens so the frame receives an opaque origin", () => {
    expect(OPAQUE_ORIGIN_ACTOR_SANDBOX).toBe("quasar.opaque-origin-iframe.v1");
    expect(OPAQUE_ORIGIN_SANDBOX_TOKENS).toEqual(["allow-scripts"]);
    expect(OPAQUE_ORIGIN_SANDBOX_TOKENS).not.toContain("allow-same-origin");
  });

  it("blocks direct network access and runs actor code in a nested worker", () => {
    const source = buildOpaqueOriginActorFrameSource();
    expect(source).toContain("connect-src 'none'");
    expect(source).toContain("worker-src blob:");
    expect(source).toContain("quasar-actor-connect");
    expect(source).toContain("new Worker");
    expect(source).not.toContain("allow-same-origin");
  });
});
