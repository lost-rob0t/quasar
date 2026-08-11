import { describe, expect, it } from "vitest";
import { createEventBus } from "../../src/control-plane/events";
import type { EventEnvelope } from "../../src/control-plane/protocol";

describe("control-plane events", () => {
  it("dispatches events to subscribers", () => {
    const bus = createEventBus();
    const received: EventEnvelope[] = [];
    bus.subscribe((e) => received.push(e));

    const event: EventEnvelope = {
      protocol: "quasar.control.v1",
      event: "document.created",
      workspace: "default",
      revision: 1,
      operationId: "op-1",
      payload: { created: "doc-1" }
    };
    bus.dispatch(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("filters by event name when provided", () => {
    const bus = createEventBus();
    const created: EventEnvelope[] = [];
    const deleted: EventEnvelope[] = [];
    bus.subscribe((e) => created.push(e), ["document.created"]);
    bus.subscribe((e) => deleted.push(e), ["document.deleted"]);

    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.created",
      workspace: "default",
      revision: 1,
      operationId: "op-1",
      payload: {}
    });
    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.deleted",
      workspace: "default",
      revision: 2,
      operationId: "op-2",
      payload: {}
    });

    expect(created).toHaveLength(1);
    expect(deleted).toHaveLength(1);
  });

  it("deduplicates by operation ID", () => {
    const bus = createEventBus();
    const received: EventEnvelope[] = [];
    bus.subscribe((e) => received.push(e));

    const event: EventEnvelope = {
      protocol: "quasar.control.v1",
      event: "document.created",
      workspace: "default",
      revision: 1,
      operationId: "op-dup",
      payload: {}
    };
    bus.dispatch(event);
    bus.dispatch(event);

    expect(received).toHaveLength(1);
  });

  it("ignores stale revisions", () => {
    const bus = createEventBus();
    const received: EventEnvelope[] = [];
    bus.subscribe((e) => received.push(e));

    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.created",
      workspace: "default",
      revision: 5,
      operationId: "op-5",
      payload: {}
    });
    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.updated",
      workspace: "default",
      revision: 3,
      operationId: "op-3",
      payload: {}
    });

    expect(received).toHaveLength(1);
    expect(received[0].operationId).toBe("op-5");
  });

  it("unsubscribes correctly", () => {
    const bus = createEventBus();
    const received: EventEnvelope[] = [];
    const unsub = bus.subscribe((e) => received.push(e));

    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.created",
      workspace: "default",
      revision: 1,
      operationId: "op-1",
      payload: {}
    });
    unsub();
    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.created",
      workspace: "default",
      revision: 2,
      operationId: "op-2",
      payload: {}
    });

    expect(received).toHaveLength(1);
  });

  it("accepts ordered transaction children at the same revision", () => {
    const bus = createEventBus();
    const received: string[] = [];
    bus.subscribe((event) => received.push(event.operationId));
    for (const eventIndex of [1, 2, 3]) {
      bus.dispatch({
        protocol: "quasar.control.v1",
        event: "document.created",
        workspace: "default",
        revision: 7,
        transactionId: "tx-1",
        operationId: `tx-1:${eventIndex}`,
        eventIndex,
        eventCount: 3,
        payload: {}
      });
    }
    expect(received).toEqual(["tx-1:1", "tx-1:2", "tx-1:3"]);
  });

  it("buffers out-of-order transaction children and delivers stable order", () => {
    const bus = createEventBus();
    const received: number[] = [];
    bus.subscribe((event) => received.push(event.eventIndex!));
    for (const eventIndex of [3, 1, 2]) {
      bus.dispatch({
        protocol: "quasar.control.v1",
        event: "document.created",
        workspace: "default",
        revision: 7,
        transactionId: "tx-out-of-order",
        operationId: `tx-out-of-order:${eventIndex}`,
        eventIndex,
        eventCount: 3,
        payload: {}
      });
    }
    expect(received).toEqual([1, 2, 3]);
  });

  it("isolates workspace revisions and ignores inactive workspaces", () => {
    const bus = createEventBus("alpha");
    const received: string[] = [];
    bus.subscribe((event) => received.push(event.workspace));
    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.created",
      workspace: "alpha",
      revision: 20,
      operationId: "alpha:20",
      payload: {}
    });
    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.created",
      workspace: "beta",
      revision: 1,
      operationId: "beta:1",
      payload: {}
    });
    bus.setWorkspace("beta");
    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.created",
      workspace: "beta",
      revision: 1,
      operationId: "beta:1",
      payload: {}
    });
    expect(received).toEqual(["alpha", "beta"]);
    expect(bus.getRevision("alpha")).toBe(20);
    expect(bus.getRevision("beta")).toBe(1);
  });

  it("bounds operation deduplication and resets reconnect state", () => {
    const bus = createEventBus();
    for (let index = 1; index <= 2_100; index += 1) {
      bus.dispatch({
        protocol: "quasar.control.v1",
        event: "document.updated",
        workspace: "default",
        revision: index,
        operationId: `op-${index}`,
        payload: {}
      });
    }
    expect(bus.getSeenOperationCount()).toBe(2_048);
    bus.reset("default");
    expect(bus.getSeenOperationCount()).toBe(0);
    expect(bus.getRevision()).toBe(0);
  });
});
