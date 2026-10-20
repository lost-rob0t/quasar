import { expect, it, vi } from "vitest";
import { readCompleteGraph, readGraphCatalog } from "./graph-session";
const doc = {
  id: "entity:a",
  dtype: "entity",
  dataset: "test",
  schemaVersion: "0.10.1",
  name: "A"
};
function fixture() {
  const sections: Record<string, unknown[]> = {
    descriptor: [
      {
        metadata: { id: "g", name: "Graph", custom: { keep: true } },
        collectionKinds: {
          documentIds: "array",
          positions: "object",
          groups: "array",
          selectedIds: "array"
        }
      }
    ],
    members: [{ documentId: doc.id }],
    positions: [{ key: doc.id, value: { x: 12, y: 4 } }],
    groups: [{ index: 0, value: { custom: "keep" } }],
    selection: [{ index: 0, value: doc.id }],
    nodes: [{ id: "sidecar" }],
    edges: [{ id: "edge", source: { id: doc.id, dataset: "test" } }]
  };
  let listener: (state: never) => void;
  const client = {
    onConnectionStateChange: (fn: typeof listener) => {
      listener = fn;
      return () => {};
    },
    send: vi.fn(async (command, payload) => {
      if (command === "graph.page")
        return {
          revision: 4,
          projection: "graph-page.v1",
          graphId: "g",
          section: payload.section,
          records: sections[payload.section],
          complete: true,
          cursor: null
        };
      if (command === "document.batch") return { revision: 4, documents: [doc], missingIds: [] };
      throw new Error(command);
    })
  };
  return { client, sections, disconnect: () => listener({ synchronized: false } as never) };
}
it("reconstructs complete graph metadata, container kinds and sidecars before opening", async () => {
  const { client } = fixture();
  const result = await readCompleteGraph(
    client as unknown as Parameters<typeof readCompleteGraph>[0],
    "g",
    4
  );
  expect(result.graph).toMatchObject({
    custom: { keep: true },
    documentIds: [doc.id],
    positions: { [doc.id]: { x: 12, y: 4 } },
    groups: [{ custom: "keep" }],
    selectedIds: [doc.id],
    nodes: [{ id: "sidecar" }],
    edges: [{ source: { id: doc.id, dataset: "test" } }]
  });
  expect(result.documents.map((doc) => doc._id)).toEqual([doc.id]);
  expect(client.send.mock.calls.every(([, payload]) => payload.expectedRevision === 4)).toBe(true);
  expect(client.send.mock.calls.some(([command]) => command === "workspace.snapshot")).toBe(false);
});
it("rejects an over-budget graph before canonical member bodies are fetched", async () => {
  const { client, sections } = fixture();
  sections.members = Array.from({ length: 51 }, (_, i) => ({ documentId: String(i) }));
  await expect(
    readCompleteGraph(client as unknown as Parameters<typeof readCompleteGraph>[0], "g", 4)
  ).rejects.toThrow("Invalid graph section");
  expect(client.send.mock.calls.some(([command]) => command === "document.batch")).toBe(false);
});
it("rejects incomplete or reordered collection metadata", async () => {
  const { client, sections } = fixture();
  sections.groups = [{ index: 2, value: {} }];
  await expect(
    readCompleteGraph(client as unknown as Parameters<typeof readCompleteGraph>[0], "g", 4)
  ).rejects.toThrow("collection order");
});
it("does not return partial graph state after a workspace change", async () => {
  const { client, disconnect } = fixture();
  const original = client.send.getMockImplementation()!;
  client.send.mockImplementation(async (...args) => {
    const result = await original(...args);
    disconnect();
    return result;
  });
  await expect(
    readCompleteGraph(client as unknown as Parameters<typeof readCompleteGraph>[0], "g", 4)
  ).rejects.toThrow("Workspace changed");
  expect(client.send).toHaveBeenCalledTimes(1);
});
it("accepts empty continuable catalog pages without treating them as complete", async () => {
  const { client } = fixture();
  client.send.mockResolvedValue({
    revision: 4,
    projection: "graph-catalog.v1",
    graphs: [],
    complete: false,
    cursor: "next"
  } as never);
  expect(
    await readGraphCatalog(client as unknown as Parameters<typeof readGraphCatalog>[0], 4)
  ).toMatchObject({ complete: false, cursor: "next" });
  expect(client.send).toHaveBeenCalledTimes(1);
});
it("rejects accumulated membership above 2000 without fetching document bodies", async () => {
  const { client } = fixture();
  const original = client.send.getMockImplementation()!;
  client.send.mockImplementation(async (command, payload) => {
    if (command !== "graph.page" || payload.section !== "members")
      return original(command, payload);
    const offset = Number(payload.cursor || 0);
    return {
      revision: 4,
      projection: "graph-page.v1",
      graphId: "g",
      section: "members",
      records: Array.from({ length: 50 }, (_, i) => ({ documentId: `entity:${offset + i}` })),
      complete: false,
      cursor: String(offset + 50)
    } as never;
  });
  await expect(
    readCompleteGraph(client as unknown as Parameters<typeof readCompleteGraph>[0], "g", 4)
  ).rejects.toThrow("interactive graph budget");
  expect(client.send.mock.calls.filter(([command]) => command === "document.batch")).toHaveLength(
    0
  );
});
