import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControlPlaneClient } from "../../src/control-plane/client";
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
  onclose: (() => void) | null = null;
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

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
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
    const pending = client.documentCreate({ _id: "person:1", dtype: "person" });

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

  it("reassembles size-bounded authoritative snapshot pages", async () => {
    const client = createControlPlaneClient("ws://quasar.test");
    const snapshots: Record<string, unknown>[] = [];
    client.onSnapshot((snapshot) => snapshots.push(snapshot));
    const socket = FakeWebSocket.instances[0];
    socket.open();

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
    expect(snapshots[0].documents).toEqual([{ _id: "document:1" }, { _id: "document:2" }]);
    expect(snapshots[0]).not.toHaveProperty("documentPage");
    client.dispose();
  });

  it("stages document chunks before committing an import", async () => {
    const client = createControlPlaneClient("ws://quasar.test");
    const socket = await connect(client);
    const importing = client.importDocuments([
      [{ type: "document.create", payload: { _id: "document:1", dtype: "note" } }],
      [{ type: "document.create", payload: { _id: "document:2", dtype: "note" } }]
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
