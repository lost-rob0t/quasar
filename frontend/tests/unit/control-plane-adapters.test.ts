import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  createAdapters,
  createDocumentAdapter,
  createGraphNodeAdapter,
  createGraphEdgeAdapter
} from "../../src/control-plane/adapters";
import type { ControlPlaneClient } from "../../src/control-plane/client";

function mockClient(): ControlPlaneClient {
  return {
    send: vi.fn(async (cmd: string, payload?: Record<string, unknown>) => {
      return { command: cmd, payload };
    }),
    subscribe: vi.fn(() => () => {}),
    snapshot: vi.fn(async () => ({ revision: 0 })),
    transaction: vi.fn(async () => ({ revision: 1 })),
    documentCreate: vi.fn(async (doc) => ({ created: doc._id })),
    documentUpdate: vi.fn(async (doc) => ({ updated: doc._id })),
    documentDelete: vi.fn(async (id) => ({ deleted: id })),
    graphSnapshot: vi.fn(async (graphId) => ({ graphId })),
    nodeCreate: vi.fn(async (node) => ({ created: node.id })),
    nodeUpdate: vi.fn(async (node) => ({ updated: node.id })),
    nodeDelete: vi.fn(async (graphId, id) => ({ deleted: id })),
    edgeCreate: vi.fn(async (edge) => ({ created: edge.id })),
    edgeUpdate: vi.fn(async (edge) => ({ updated: edge.id })),
    edgeDelete: vi.fn(async (graphId, id) => ({ deleted: id })),
    getConnected: vi.fn(() => true),
    getRevision: vi.fn(() => 0),
    setWorkspace: vi.fn(),
    dispose: vi.fn()
  } as unknown as ControlPlaneClient;
}

describe("control-plane adapters", () => {
  let client: ControlPlaneClient;

  beforeEach(() => {
    client = mockClient();
  });

  it("document adapter routes create through client", async () => {
    const adapter = createDocumentAdapter(client);
    const result = await adapter.create({ _id: "person:1", dtype: "person" });
    expect(client.documentCreate).toHaveBeenCalledWith({ _id: "person:1", dtype: "person" });
    expect(result).toEqual({ created: "person:1" });
  });

  it("document adapter routes update through client", async () => {
    const adapter = createDocumentAdapter(client);
    await adapter.update({ _id: "person:1", note: "updated" });
    expect(client.documentUpdate).toHaveBeenCalledWith({ _id: "person:1", note: "updated" });
  });

  it("document adapter routes remove through client", async () => {
    const adapter = createDocumentAdapter(client);
    await adapter.remove("person:1");
    expect(client.documentDelete).toHaveBeenCalledWith("person:1");
  });

  it("graph node adapter routes create through client", async () => {
    const adapter = createGraphNodeAdapter(client);
    const result = await adapter.create({ id: "node-1", graphId: "g1" });
    expect(client.nodeCreate).toHaveBeenCalledWith({ id: "node-1", graphId: "g1" });
    expect(result).toEqual({ created: "node-1" });
  });

  it("graph node adapter routes remove through client", async () => {
    const adapter = createGraphNodeAdapter(client);
    await adapter.remove("g1", "node-1");
    expect(client.nodeDelete).toHaveBeenCalledWith("g1", "node-1");
  });

  it("graph edge adapter routes create through client", async () => {
    const adapter = createGraphEdgeAdapter(client);
    await adapter.create({ id: "edge-1", source: "a", target: "b", graphId: "g1" });
    expect(client.edgeCreate).toHaveBeenCalledWith({
      id: "edge-1",
      source: "a",
      target: "b",
      graphId: "g1"
    });
  });

  it("createAdapters returns all adapters", () => {
    const adapters = createAdapters(client);
    expect(adapters.document).toBeDefined();
    expect(adapters.node).toBeDefined();
    expect(adapters.edge).toBeDefined();
    expect(adapters.workspace).toBeDefined();
    expect(adapters.client).toBe(client);
  });
});
