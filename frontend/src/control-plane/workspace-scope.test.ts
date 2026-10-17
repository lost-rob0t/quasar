import { describe, expect, it, vi } from "vitest";
import { withWorkspaceScope } from "./workspace-scope";
import type { ConnectionState } from "./client";
function fixture() {
  let notify: (state: ConnectionState) => void = () => {};
  const unsubscribe = vi.fn();
  const client = {
    onConnectionStateChange(listener: typeof notify) {
      notify = listener;
      listener({
        phase: "connected",
        connected: true,
        synchronized: true,
        attempts: 0,
        workspaceId: "a"
      });
      return unsubscribe;
    }
  };
  return {
    client,
    unsubscribe,
    invalidate: () =>
      notify({
        phase: "reconnecting",
        connected: false,
        synchronized: false,
        attempts: 1,
        workspaceId: "b"
      })
  };
}
describe("long-running consumer scope", () => {
  it("aborts an actor signal and rejects late output before application", async () => {
    const { client, unsubscribe, invalidate } = fixture();
    const apply = vi.fn();
    await expect(
      withWorkspaceScope(client, async (check, signal) => {
        await Promise.resolve();
        invalidate();
        expect(signal.aborted).toBe(true);
        check();
        apply();
      })
    ).rejects.toMatchObject({ code: "query.cancelled" });
    expect(apply).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("releases subscriptions after successful execution and exceptions", async () => {
    const { client, unsubscribe } = fixture();
    await expect(
      withWorkspaceScope(client, async (check) => {
        check();
        return 42;
      })
    ).resolves.toBe(42);
    await expect(
      withWorkspaceScope(client, async () => {
        throw new Error("worker failed");
      })
    ).rejects.toThrow("worker failed");
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
