import { describe, expect, it } from "vitest";
import { createResearchNode } from "./research-nodes";
import {
  buildGraph,
  filterGraph,
  findPaths,
  graphStatistics,
  importedGraphNodeIds,
  normalizeDirected,
  partitionDocumentsByReview,
  reviewState
} from "./graph";

const stamp = "2026-07-25T20:00:00.000Z";
const base = (
  id,
  dtype,
  data,
  verification = { verified: true, status: "verified" },
  dataset = "test"
) => ({
  _id: id,
  dataset,
  dtype,
  schema_version: "0.9.0",
  version: 1,
  date_added: stamp,
  date_updated: stamp,
  title: id,
  sources: [],
  evidence: [],
  verification,
  data
});

const documents = [
  base("starintel:person:a", "person", { full_name: "A" }),
  base("starintel:org:b", "org", { name: "B" }),
  base("starintel:org:c", "org", { name: "C" }, { verified: true, status: "verified" }, "second"),
  base("starintel:relation:a-b", "relation", {
    subject: "starintel:person:a",
    predicate: "founded",
    object: "starintel:org:b",
    confidence: 0.9
  }),
  base(
    "starintel:relation:b-c",
    "relation",
    { subject: "starintel:org:b", predicate: "owns", object: "starintel:org:c", confidence: 0.8 },
    { verified: true, status: "verified" },
    "second"
  )
];

const unreviewedEvent = base(
  "starintel:event:pending",
  "event",
  { name: "Pending event" },
  { verified: false, status: "unverified" }
);

describe("StarIntel graph projection", () => {
  it("projects entity documents to nodes and relations to edges", () => {
    const graph = buildGraph(documents);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges[0].data.predicate).toBe("founded");
    expect(graph.nodes[0].data.reviewState).toBe("reviewed");
  });

  it("projects research node state into graph presentation data", () => {
    const researchNode = createResearchNode({
      id: "starintel:research-node:map",
      dataset: "test",
      title: "Map the network",
      objective: "Map the network",
      status: "running",
      createdAt: stamp
    });
    const graph = buildGraph([researchNode]);
    expect(graph.nodes[0].data).toMatchObject({
      dtype: "research-node",
      shape: "round-hexagon",
      color: "#ec4899",
      researchStatus: "running",
      researchLabel: "Map the network\n[running]"
    });
  });

  it("projects every relation direction as a boolean with directed as the legacy default", () => {
    const relations = [
      base("starintel:relation:true", "relation", {
        subject: "starintel:person:a",
        predicate: "a",
        object: "starintel:org:b",
        directed: true
      }),
      base("starintel:relation:false", "relation", {
        subject: "starintel:person:a",
        predicate: "b",
        object: "starintel:org:b",
        directed: false
      }),
      base("starintel:relation:legacy-false", "relation", {
        subject: "starintel:person:a",
        predicate: "c",
        object: "starintel:org:b",
        directed: "false"
      }),
      base("starintel:relation:missing", "relation", {
        subject: "starintel:person:a",
        predicate: "d",
        object: "starintel:org:b"
      })
    ];
    const graph = buildGraph([...documents.slice(0, 3), ...relations]);

    expect(graph.edges.map((edge) => edge.data.directed)).toEqual([true, false, false, true]);
    expect(graph.edges.every((edge) => typeof edge.data.directed === "boolean")).toBe(true);
    expect(normalizeDirected("invalid-legacy-value")).toBe(true);
  });

  it("retains unresolved relation endpoints", () => {
    const graph = buildGraph([
      ...documents,
      base("starintel:relation:missing", "relation", {
        subject: "starintel:org:c",
        predicate: "mentions",
        object: "starintel:entity:missing"
      })
    ]);
    expect(
      graph.nodes.find((node) => node.data.id === "starintel:entity:missing")?.data.unresolved
    ).toBe(true);
  });

  it("focuses imported nodes and the endpoints of imported relations", () => {
    const graph = buildGraph(documents);
    expect(importedGraphNodeIds(graph, ["starintel:relation:a-b", "starintel:org:c"])).toEqual([
      "starintel:org:c",
      "starintel:person:a",
      "starintel:org:b"
    ]);
  });

  it("finds ranked connection paths", () => {
    const graph = buildGraph(documents);
    const paths = findPaths(graph, "starintel:person:a", "starintel:org:c");
    expect(paths[0].nodes).toEqual(["starintel:person:a", "starintel:org:b", "starintel:org:c"]);
    expect(paths[0].edges).toHaveLength(2);
  });

  it("filters by dataset, dtype, and predicate", () => {
    const graph = buildGraph(documents);
    const byDataset = filterGraph(graph, { dataset: "second" });
    expect(byDataset.nodes.map((node) => node.data.id)).toEqual(["starintel:org:c"]);

    const byDtype = filterGraph(graph, { dtype: "person" });
    expect(byDtype.nodes.map((node) => node.data.id)).toEqual(["starintel:person:a"]);

    const byPredicate = filterGraph(graph, { predicate: "owns" });
    expect(byPredicate.edges).toHaveLength(1);
    expect(byPredicate.nodes.map((node) => node.data.id).sort()).toEqual([
      "starintel:org:b",
      "starintel:org:c"
    ]);
  });

  it("classifies reviewed records from canonical verification metadata", () => {
    expect(reviewState(documents[0])).toBe("reviewed");
    expect(reviewState(unreviewedEvent)).toBe("unreviewed");
    expect(reviewState({ verification: { status: "reviewed" } })).toBe("reviewed");
    expect(reviewState({ verification: { last_reviewed_at: stamp } })).toBe("reviewed");
    expect(reviewState({})).toBe("unreviewed");
  });

  it("partitions reviewed and unreviewed documents without mixing totals", () => {
    const groups = partitionDocumentsByReview([...documents, unreviewedEvent]);
    expect(groups.reviewed).toHaveLength(5);
    expect(groups.unreviewed).toEqual([unreviewedEvent]);
  });

  it("computes reviewed dashboard statistics separately", () => {
    const stats = graphStatistics([...documents, unreviewedEvent]);
    expect(stats.documents).toBe(6);
    expect(stats.reviewedDocuments).toBe(5);
    expect(stats.unreviewedDocuments).toBe(1);
    expect(stats.reviewedEntities).toBe(3);
    expect(stats.reviewedRelations).toBe(2);
    expect(stats.reviewedEvents).toBe(0);
    expect(stats.unreviewedByDtype.event).toBe(1);
    expect(stats.topConnected[0].id).toBe("starintel:org:b");
  });
});
