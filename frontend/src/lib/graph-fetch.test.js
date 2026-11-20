import { describe, expect, it, vi } from "vitest";
import { localNeighborIds, walkLocalGraph, walkRemoteGraph } from "./graph-fetch";

function relation(id, subject, object) {
  return { _id: id, dtype: "relation", data: { subject, object, predicate: "linked-to" } };
}

function entity(id) {
  return { _id: id, dtype: "person", data: { name: id } };
}

const corpus = [
  entity("a"),
  entity("b"),
  entity("c"),
  entity("d"),
  entity("orphan"),
  relation("r-ab", "a", "b"),
  relation("r-ac", "a", "c"),
  relation("r-bd", "b", "d"),
  relation("r-self", "a", "a")
];

describe("localNeighborIds", () => {
  it("returns distinct counterparts without the node itself", () => {
    expect(localNeighborIds(corpus, "a").sort()).toEqual(["b", "c"]);
  });

  it("returns empty for isolated documents", () => {
    expect(localNeighborIds(corpus, "orphan")).toEqual([]);
  });
});

describe("walkLocalGraph", () => {
  it("collects one hop with connecting relations", () => {
    const result = walkLocalGraph(corpus, "a", { depth: 1 });
    expect(result.documents.map((document) => document._id).sort()).toEqual(["a", "b", "c"]);
    expect(result.relations.map((document) => document._id).sort()).toEqual(["r-ab", "r-ac"]);
    expect(result.truncated).toBe(false);
  });

  it("walks depth 2 transitively", () => {
    const result = walkLocalGraph(corpus, "a", { depth: 2 });
    expect(result.documents.map((document) => document._id).sort()).toEqual([
      "a",
      "b",
      "c",
      "d"
    ]);
    expect(result.visited).toContain("d");
  });

  it("respects the document budget", () => {
    const result = walkLocalGraph(corpus, "a", { depth: 2, budget: 2 });
    expect(result.documents.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it("returns empty for unknown roots", () => {
    expect(walkLocalGraph(corpus, "missing").documents).toEqual([]);
  });
});

describe("walkRemoteGraph", () => {
  function fakeClient(neighborsByNode) {
    const calls = { neighbors: 0, documents: 0 };
    const client = {
      starintelNeighbors: vi.fn(async ({ id, bookmark }) => {
        calls.neighbors += 1;
        const all = neighborsByNode[id] || [];
        if (bookmark) return { relations: [], bookmark: null };
        return {
          document: entity(id),
          relations: all,
          bookmark: all.length > 1 ? `cursor-${id}` : null
        };
      }),
      starintelDocument: vi.fn(async ({ id }) => {
        calls.documents += 1;
        return entity(id);
      })
    };
    return { client, calls };
  }

  it("walks depth 1 fetching each neighbor document once", async () => {
    const { client, calls } = fakeClient({
      a: [
        { id: "r1", neighbor: "b", predicate: "knows", direction: "subject" },
        { id: "r2", neighbor: "c", predicate: "knows", direction: "subject" }
      ]
    });
    const result = await walkRemoteGraph(client, { url: "http://x" }, "a", { depth: 1 });
    expect(result.documents.map((document) => document._id).sort()).toEqual(["a", "b", "c"]);
    expect(result.relations).toHaveLength(2);
    expect(calls.documents).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("caps pages per node via the cursor and stops the loop", async () => {
    const { client, calls } = fakeClient({
      a: [
        { id: "r1", neighbor: "b", predicate: "knows", direction: "subject" },
        { id: "r2", neighbor: "c", predicate: "knows", direction: "subject" }
      ]
    });
    await walkRemoteGraph(client, { url: "http://x" }, "a", { depth: 1, limit: 1 });
    // One page returns a bookmark; the follow-up page is empty and ends it.
    expect(calls.neighbors).toBe(2);
  });

  it("marks truncation when the budget is hit", async () => {
    const { client } = fakeClient({
      a: [
        { id: "r1", neighbor: "b", predicate: "knows", direction: "subject" },
        { id: "r2", neighbor: "c", predicate: "knows", direction: "subject" },
        { id: "r3", neighbor: "d", predicate: "knows", direction: "subject" }
      ]
    });
    const result = await walkRemoteGraph(client, { url: "http://x" }, "a", {
      depth: 1,
      budget: 2
    });
    expect(result.documents.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it("survives unreachable neighbors", async () => {
    const client = {
      starintelNeighbors: vi.fn(async ({ id }) => ({
        document: entity(id),
        relations: [{ id: "r1", neighbor: "dead", predicate: "knows", direction: "subject" }],
        bookmark: null
      })),
      starintelDocument: vi.fn(async () => {
        throw new Error("not found");
      })
    };
    const result = await walkRemoteGraph(client, { url: "http://x" }, "a", { depth: 1 });
    expect(result.documents.map((document) => document._id)).toEqual(["a"]);
    expect(result.visited).toContain("dead");
  });
});
