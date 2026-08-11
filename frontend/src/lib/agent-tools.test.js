import { describe, expect, it, vi } from "vitest";
import { assertToolPermission, createAgentToolRegistry } from "./agent-tools";

const person = {
  _id: "person:1",
  dataset: "alpha",
  dtype: "person",
  title: "Alice",
  data: { name: "Alice" },
  sources: []
};
const org = {
  _id: "org:1",
  dataset: "alpha",
  dtype: "org",
  title: "Example Org",
  data: { name: "Example Org" },
  sources: []
};
const relation = {
  _id: "relation:1",
  dataset: "alpha",
  dtype: "relation",
  title: "member-of",
  data: { subject: "person:1", predicate: "member-of", object: "org:1", directed: true },
  sources: []
};

describe("agent tools", () => {
  it("enforces permissions outside model output", () => {
    expect(() => assertToolPermission({ permissions: [] }, "documents.read")).toThrow(
      "Permission denied"
    );
  });

  it("queries the scoped database", async () => {
    const registry = createAgentToolRegistry({
      getDocuments: async () => [person, org, relation],
      getGraphDocuments: async () => [person, org, relation]
    });
    const result = await registry.execute(
      "query_database",
      {
        text: "Alice",
        datasets: ["alpha"]
      },
      {
        agent: { permissions: ["documents.read"], datasetAccess: ["alpha"] }
      }
    );
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].objectType).toBe("person");
  });

  it("queries graph paths", async () => {
    const registry = createAgentToolRegistry({
      getDocuments: async () => [person, org, relation],
      getGraphDocuments: async () => [person, org, relation]
    });
    const result = await registry.execute(
      "query_graph",
      {
        pathFrom: "person:1",
        pathTo: "org:1"
      },
      {
        agent: { permissions: ["graph.read"] }
      }
    );
    expect(result.paths[0].predicates).toEqual(["member-of"]);
  });

  it("runs actors only through the declared environment", async () => {
    const runActor = vi.fn(async () => ({ affected: [] }));
    const registry = createAgentToolRegistry({ runActor });
    await registry.execute(
      "run_actor",
      { actorId: "actor:test" },
      {
        agent: { permissions: ["actors.run"], actorAccess: ["*"] },
        selectionIds: ["person:1"]
      }
    );
    expect(runActor).toHaveBeenCalledWith("actor:test", ["person:1"]);
  });

  it("builds a custom graph through the declared environment", async () => {
    const buildCustomGraph = vi.fn(async () => ({ graphId: "graph:1" }));
    const registry = createAgentToolRegistry({ buildCustomGraph });
    const context = { agent: { permissions: ["graph.edit"] } };
    await registry.execute(
      "build_graph",
      { name: "Case graph", documentIds: ["person:1"] },
      context
    );
    expect(buildCustomGraph).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Case graph" }),
      context
    );
  });

  it("scrapes websites only through the declared environment", async () => {
    const scrapeWebsite = vi.fn(async () => ({ pageCount: 2, pages: [] }));
    const registry = createAgentToolRegistry({ scrapeWebsite });
    const context = { agent: { permissions: ["sources.external"] } };
    await registry.execute(
      "scrape_website",
      {
        url: "https://example.org",
        maxPages: 2,
        maxDepth: 1
      },
      context
    );
    expect(scrapeWebsite).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.org",
        maxPages: 2
      }),
      context
    );
  });
});
