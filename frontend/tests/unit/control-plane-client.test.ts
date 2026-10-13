import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticatedWebSocketUrl,
  createControlPlaneClient
} from "../../src/control-plane/client";
import { PROTOCOL_VERSION } from "../../src/control-plane/protocol";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(message: string) {
    this.sent.push(message);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }

  respond(result: unknown, index = this.sent.length - 1) {
    const command = JSON.parse(this.sent[index]) as { id: string };
    this.onmessage?.({
      data: JSON.stringify({
        protocol: PROTOCOL_VERSION,
        id: command.id,
        status: "ok",
        result
      })
    });
  }
}

async function connect(client: ReturnType<typeof createControlPlaneClient>) {
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  expect(JSON.parse(socket.sent[0]).command).toBe("workspace.snapshot");
  socket.respond({ id: "default", revision: 3, documents: [], graphs: [] }, 0);
  await vi.waitFor(() => expect(client.getConnected()).toBe(true));
  return socket;
}

describe("control-plane client lifecycle", () => {
  it("builds the configured hosted websocket endpoint", () => {
    expect(authenticatedWebSocketUrl("/control-ws", "https://quasar.example/graph")).toBe(
      "wss://quasar.example/control-ws"
    );
    expect(() =>
      authenticatedWebSocketUrl("https://quasar.example/control-ws", "https://quasar.example/")
    ).toThrow(/WebSocket transport/);
  });

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects pending requests immediately when the socket closes", async () => {
    const client = createControlPlaneClient("ws://quasar.test");
    const socket = await connect(client);
    const pending = client.documentCreate({
      id: "person:1",
      dtype: "person",
      dataset: "test",
      schemaVersion: "0.10.1"
    });

    socket.close();

    await expect(pending).rejects.toMatchObject({
      code: "control-plane.unavailable"
    });
    expect(client.getConnected()).toBe(false);
    client.dispose();
  });

  it("takes a fresh snapshot before declaring a reconnect synchronized", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const client = createControlPlaneClient("ws://quasar.test");
    const snapshots: Record<string, unknown>[] = [];
    client.onSnapshot((snapshot) => snapshots.push(snapshot));
    const first = FakeWebSocket.instances[0];
    first.open();
    first.respond({ id: "default", revision: 1, documents: [], graphs: [] }, 0);
    await vi.waitFor(() => expect(client.getConnected()).toBe(true));

    first.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];
    second.open();
    expect(client.getConnected()).toBe(false);
    expect(JSON.parse(second.sent[0]).command).toBe("workspace.snapshot");
    second.respond({ id: "default", revision: 9, documents: [], graphs: [] }, 0);
    await vi.waitFor(() => expect(client.getConnected()).toBe(true));
    expect(client.getRevision()).toBe(9);
    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([1, 9]);
    client.dispose();
  });

  it("does not close the current socket when an obsolete workspace sync fails", async () => {
    const client = createControlPlaneClient("ws://quasar.test");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    client.setWorkspace("next");
    socket.respond({ id: "next", revision: 1, documents: [], graphs: [] }, 1);
    await vi.waitFor(() => expect(client.getConnected()).toBe(true));
    const old = JSON.parse(socket.sent[0]);
    socket.onmessage?.({
      data: JSON.stringify({
        protocol: PROTOCOL_VERSION,
        id: old.id,
        status: "error",
        error: { code: "workspace.not-found", message: "Old workspace gone", details: {} }
      })
    });
    await Promise.resolve();
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(client.getConnected()).toBe(true);
    client.dispose();
  });

  it("does not report a synchronization failure after a transport close", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    vi.stubGlobal("window", {
      sessionStorage: { getItem: () => null },
      location: { search: "" },
      localStorage: { getItem: () => null },
      dispatchEvent: (event: CustomEvent) => {
        events.push(event.detail.message);
      }
    });
    const client = createControlPlaneClient("ws://quasar.test");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.close();
    await Promise.resolve();
    expect(events).not.toContain("Workspace synchronization failed.");
    client.dispose();
  });

  it("reassembles size-bounded authoritative snapshot pages", async () => {
    const client = createControlPlaneClient("ws://quasar.test");
    const snapshots: Record<string, unknown>[] = [];
    client.onSnapshot((snapshot) => snapshots.push(snapshot));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const states: unknown[] = [];
    client.onConnectionStateChange((state) => states.push(state));
    expect(states.at(-1)).toMatchObject({ phase: "synchronizing", synchronized: false });

    expect(JSON.parse(socket.sent[0]).payload).toMatchObject({
      documentOffset: 0,
      documentByteLimit: 512 * 1024
    });
    socket.respond({
      id: "default",
      revision: 4,
      documents: [{ _id: "document:1" }],
      graphs: [],
      documentPage: { nextOffset: 1, total: 2, complete: false }
    });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(states.at(-1)).toMatchObject({
      phase: "synchronizing",
      progress: { received: 1, total: 2 }
    });
    expect(JSON.parse(socket.sent[1]).payload.documentOffset).toBe(1);
    socket.respond(
      {
        id: "default",
        revision: 4,
        documents: [{ _id: "document:2" }],
        graphs: [],
        documentPage: { nextOffset: 2, total: 2, complete: true }
      },
      1
    );

    await vi.waitFor(() => expect(client.getConnected()).toBe(true));
    expect(states.at(-1)).toMatchObject({ phase: "connected", synchronized: true });
    expect(states.at(-1)).toHaveProperty("progress", undefined);
    expect(snapshots[0].documents).toEqual([{ _id: "document:1" }, { _id: "document:2" }]);
    expect(snapshots[0]).not.toHaveProperty("documentPage");
    client.dispose();
  });

  it("stages document chunks before committing an import", async () => {
    const client = createControlPlaneClient("ws://quasar.test");
    const socket = await connect(client);
    const importing = client.importDocuments([
      [
        {
          type: "document.create",
          payload: { id: "document:1", dtype: "document", dataset: "test", schemaVersion: "0.10.1" }
        }
      ],
      [
        {
          type: "document.create",
          payload: { id: "document:2", dtype: "document", dataset: "test", schemaVersion: "0.10.1" }
        }
      ]
    ]);

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(JSON.parse(socket.sent[1]).command).toBe("document.import.begin");
    socket.respond({ sessionId: "import-1", baseRevision: 3 }, 1);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(JSON.parse(socket.sent[2])).toMatchObject({
      command: "document.import.chunk",
      payload: { sessionId: "import-1" }
    });
    socket.respond({ sessionId: "import-1", documentCount: 1 }, 2);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(4));
    socket.respond({ sessionId: "import-1", documentCount: 2 }, 3);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(5));
    expect(JSON.parse(socket.sent[4]).command).toBe("document.import.commit");
    socket.respond({ operationId: "import-1", revision: 4, documentCount: 2 }, 4);

    await expect(importing).resolves.toMatchObject({ revision: 4, documentCount: 2 });
    client.dispose();
  });

  it("disposes idempotently without reconnecting or retaining timers", async () => {
    vi.useFakeTimers();
    const client = createControlPlaneClient("ws://quasar.test");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.respond({ id: "default", revision: 0, documents: [], graphs: [] }, 0);
    await vi.runAllTicks();

    client.dispose();
    client.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    await expect(client.snapshot()).rejects.toMatchObject({
      code: "control-plane.unavailable"
    });
  });
});

describe("canonical control-plane wire", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("rejects a falsely relabeled nested document before transmission", async () => {
    const client = createControlPlaneClient("ws://quasar.test");
    const socket = await connect(client);
    const count = socket.sent.length;
    await expect(
      client.documentCreate({
        id: "bad",
        dataset: "test",
        dtype: "person",
        schemaVersion: "0.10.1",
        data: {}
      })
    ).rejects.toThrow();
    expect(socket.sent).toHaveLength(count);
    client.dispose();
  });
});
