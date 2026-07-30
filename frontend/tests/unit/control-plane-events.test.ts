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
      payload: { created: "doc-1" },
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
      payload: {},
    });
    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.deleted",
      workspace: "default",
      revision: 2,
      operationId: "op-2",
      payload: {},
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
      payload: {},
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
      payload: {},
    });
    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.updated",
      workspace: "default",
      revision: 3,
      operationId: "op-3",
      payload: {},
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
      payload: {},
    });
    unsub();
    bus.dispatch({
      protocol: "quasar.control.v1",
      event: "document.created",
      workspace: "default",
      revision: 2,
      operationId: "op-2",
      payload: {},
    });

    expect(received).toHaveLength(1);
  });
});
