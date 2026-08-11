import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createReconnectManager } from "../../src/control-plane/reconnect";

describe("control-plane reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses bounded exponential backoff", () => {
    const onReconnect = vi.fn();
    const stateChanges: Array<{ connected: boolean; attempts: number; delay: number }> = [];
    const mgr = createReconnectManager(onReconnect, (s) =>
      stateChanges.push({ ...s, delay: (s as { delay?: number }).delay ?? 0 })
    );

    mgr.markDisconnected();
    expect(stateChanges.at(-1)).toMatchObject({ connected: false });

    // First attempt delay should be around BASE_DELAY (500ms)
    const firstDelay = stateChanges.at(-1)?.delay ?? 0;
    expect(firstDelay).toBeGreaterThanOrEqual(400);
    expect(firstDelay).toBeLessThanOrEqual(800);

    // Advance timer to trigger first reconnect
    vi.advanceTimersByTime(1000);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // Second reconnect
    mgr.markDisconnected();
    vi.advanceTimersByTime(3000);
    expect(onReconnect).toHaveBeenCalledTimes(2);

    // Third reconnect
    mgr.markDisconnected();
    const thirdDelay = stateChanges.at(-1)?.delay ?? 0;
    expect(thirdDelay).toBeLessThanOrEqual(30_000); // MAX_DELAY cap
    vi.advanceTimersByTime(35_000);
    expect(onReconnect).toHaveBeenCalledTimes(3);
  });

  it("resets on successful connection", () => {
    const onReconnect = vi.fn();
    const mgr = createReconnectManager(onReconnect, () => {});

    mgr.markDisconnected();
    mgr.markConnected();
    expect(mgr.state.connected).toBe(true);
    expect(mgr.state.attempts).toBe(0);
  });

  it("stops on dispose", () => {
    const onReconnect = vi.fn();
    const mgr = createReconnectManager(onReconnect, () => {});
    mgr.markDisconnected();
    mgr.stop();
    vi.advanceTimersByTime(60_000);
    expect(onReconnect).not.toHaveBeenCalled();
  });
});
