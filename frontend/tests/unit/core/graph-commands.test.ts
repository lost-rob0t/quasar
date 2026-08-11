import { describe, expect, it } from "vitest";
import {
  applyGraphBatch,
  applyGraphCommand,
  createGraphDocument,
  createGraphEdge,
  createGraphNode,
  type CanonicalGraphDocument,
  type GraphCommand
} from "../../../src/core";
import { FIXTURE_TIMESTAMP } from "../../../src/testing/graph-fixtures";

const NEXT_TIMESTAMP = "2026-01-02T00:00:00.000Z";

function graphFixture(): CanonicalGraphDocument {
  return createGraphDocument({
    id: "graph:commands",
    name: "Command graph",
    timestamp: FIXTURE_TIMESTAMP,
    nodes: [
      createGraphNode({
        id: "person:ada",
        type: "person",
        label: "Ada Lovelace",
        properties: { full_name: "Ada Lovelace" },
        position: { x: 0, y: 0 },
        createdAt: FIXTURE_TIMESTAMP
      }),
      createGraphNode({
        id: "org:analytical-society",
        type: "org",
        label: "Analytical Society",
        properties: { name: "Analytical Society" },
        position: { x: 200, y: 0 },
        createdAt: FIXTURE_TIMESTAMP
      }),
      createGraphNode({
        id: "event:lecture",
        type: "event",
        label: "Lecture",
        properties: { name: "Lecture" },
        position: { x: 400, y: 0 },
        createdAt: FIXTURE_TIMESTAMP
      })
    ],
    edges: [
      createGraphEdge({
        id: "edge:membership",
        type: "member-of",
        source: "person:ada",
        target: "org:analytical-society",
        createdAt: FIXTURE_TIMESTAMP
      }),
      createGraphEdge({
        id: "edge:participation",
        type: "participated-in",
        source: "person:ada",
        target: "event:lecture",
        createdAt: FIXTURE_TIMESTAMP
      })
    ],
    selectedIds: ["person:ada"]
  });
}

function expectSuccess(result: ReturnType<typeof applyGraphCommand>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("; "));
  return result;
}

function expectRejection(result: ReturnType<typeof applyGraphCommand>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected command rejection");
  return result;
}

describe("graph commands", () => {
  it("adds a node without mutating the source graph", () => {
    const source = graphFixture();
    const result = expectSuccess(
      applyGraphCommand(source, {
        type: "add-node",
        timestamp: NEXT_TIMESTAMP,
        node: createGraphNode({
          id: "concept:engine",
          type: "concept",
          label: "Analytical engine",
          properties: { name: "Analytical engine" },
          createdAt: NEXT_TIMESTAMP
        })
      })
    );

    expect(source.nodes).toHaveLength(3);
    expect(result.graph).not.toBe(source);
    expect(result.graph.nodes.map((node) => node.id)).toContain("concept:engine");
    expect(result.effects.addedNodeIds).toEqual(["concept:engine"]);
    expect(result.graph.metadata.updatedAt).toBe(NEXT_TIMESTAMP);
  });

  it("updates a node while preserving its identity and creation timestamp", () => {
    const source = graphFixture();
    const result = expectSuccess(
      applyGraphCommand(source, {
        type: "update-node",
        id: "person:ada",
        timestamp: NEXT_TIMESTAMP,
        patch: {
          label: "Augusta Ada King",
          properties: { full_name: "Augusta Ada King" },
          extensions: { editedBy: "unit-test" }
        }
      })
    );
    const node = result.graph.nodes.find((item) => item.id === "person:ada");

    expect(node).toMatchObject({
      id: "person:ada",
      label: "Augusta Ada King",
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: NEXT_TIMESTAMP,
      properties: { full_name: "Augusta Ada King" },
      extensions: { editedBy: "unit-test" }
    });
    expect(source.nodes[0].label).toBe("Ada Lovelace");
    expect(result.effects.updatedNodeIds).toEqual(["person:ada"]);
  });

  it("rejects a node update that violates connected edge constraints", () => {
    const source = graphFixture();
    const result = expectRejection(
      applyGraphCommand(source, {
        type: "update-node",
        id: "person:ada",
        timestamp: NEXT_TIMESTAMP,
        patch: { type: "org" }
      })
    );

    expect(result.graph).toBe(source);
    expect(result.errors[0]).toMatchObject({ code: "validation-failed" });
    expect(result.errors[0].validation?.map((error) => error.code)).toContain("endpoint-violation");
    expect(source.nodes[0].type).toBe("person");
  });

  it("removes a node and attached edges deterministically", () => {
    const source = graphFixture();
    source.edges.reverse();
    const result = expectSuccess(
      applyGraphCommand(source, {
        type: "remove-node",
        id: "person:ada",
        timestamp: NEXT_TIMESTAMP
      })
    );

    expect(result.graph.nodes.map((node) => node.id)).not.toContain("person:ada");
    expect(result.graph.edges).toEqual([]);
    expect(result.graph.view.selectedIds).toEqual([]);
    expect(result.effects.removedNodeIds).toEqual(["person:ada"]);
    expect(result.effects.removedEdgeIds).toEqual(["edge:membership", "edge:participation"]);
    expect(result.effects.viewChanged).toBe(true);
  });

  it("adds, updates, and removes edges through one interface", () => {
    const source = graphFixture();
    const added = expectSuccess(
      applyGraphCommand(source, {
        type: "add-edge",
        timestamp: NEXT_TIMESTAMP,
        edge: createGraphEdge({
          id: "edge:organization-event",
          type: "participated-in",
          source: "org:analytical-society",
          target: "event:lecture",
          label: "Hosted",
          createdAt: NEXT_TIMESTAMP
        })
      })
    );
    const updated = expectSuccess(
      applyGraphCommand(added.graph, {
        type: "update-edge",
        id: "edge:organization-event",
        timestamp: NEXT_TIMESTAMP,
        patch: { label: "Organized", properties: { confidence: 0.9 } }
      })
    );
    const removed = expectSuccess(
      applyGraphCommand(updated.graph, {
        type: "remove-edge",
        id: "edge:organization-event",
        timestamp: NEXT_TIMESTAMP
      })
    );

    expect(added.effects.addedEdgeIds).toEqual(["edge:organization-event"]);
    expect(updated.graph.edges.find((edge) => edge.id === "edge:organization-event")).toMatchObject(
      { label: "Organized", properties: { confidence: 0.9 } }
    );
    expect(updated.effects.updatedEdgeIds).toEqual(["edge:organization-event"]);
    expect(removed.graph.edges.map((edge) => edge.id)).not.toContain("edge:organization-event");
    expect(removed.effects.removedEdgeIds).toEqual(["edge:organization-event"]);
  });

  it("moves multiple nodes as one command", () => {
    const source = graphFixture();
    const result = expectSuccess(
      applyGraphCommand(source, {
        type: "move-nodes",
        timestamp: NEXT_TIMESTAMP,
        positions: {
          "person:ada": { x: 50, y: 75 },
          "org:analytical-society": { x: 300, y: 100 }
        }
      })
    );

    expect(result.graph.nodes.find((node) => node.id === "person:ada")?.position).toEqual({
      x: 50,
      y: 75
    });
    expect(
      result.graph.nodes.find((node) => node.id === "org:analytical-society")?.position
    ).toEqual({ x: 300, y: 100 });
    expect(result.effects.movedNodeIds).toEqual(["person:ada", "org:analytical-society"]);
    expect(source.nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("rejects all node movement when any target is missing", () => {
    const source = graphFixture();
    const result = expectRejection(
      applyGraphCommand(source, {
        type: "move-nodes",
        timestamp: NEXT_TIMESTAMP,
        positions: {
          "person:ada": { x: 50, y: 75 },
          "person:missing": { x: 100, y: 100 }
        }
      })
    );

    expect(result.graph).toBe(source);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "not-found", path: "positions.person:missing" })
      ])
    );
    expect(source.nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("sets viewport and view state", () => {
    const source = graphFixture();
    const viewport = expectSuccess(
      applyGraphCommand(source, {
        type: "set-viewport",
        timestamp: NEXT_TIMESTAMP,
        viewport: { zoom: 1.5, pan: { x: 25, y: -10 } }
      })
    );
    const view = expectSuccess(
      applyGraphCommand(viewport.graph, {
        type: "set-view",
        timestamp: NEXT_TIMESTAMP,
        patch: {
          layout: "grid",
          selectedIds: ["org:analytical-society"],
          extensions: { hiddenTypes: ["event"] }
        }
      })
    );

    expect(viewport.graph.view.viewport).toEqual({
      zoom: 1.5,
      pan: { x: 25, y: -10 }
    });
    expect(view.graph.view).toMatchObject({
      layout: "grid",
      selectedIds: ["org:analytical-society"],
      extensions: { hiddenTypes: ["event"] }
    });
    expect(view.effects.viewChanged).toBe(true);
  });

  it("returns structured not-found and duplicate rejections", () => {
    const source = graphFixture();
    const missing = expectRejection(
      applyGraphCommand(source, {
        type: "remove-edge",
        id: "edge:missing"
      })
    );
    const duplicate = expectRejection(
      applyGraphCommand(source, {
        type: "add-node",
        node: createGraphNode({
          id: "person:ada",
          type: "person",
          label: "Duplicate",
          createdAt: NEXT_TIMESTAMP
        })
      })
    );

    expect(missing.errors).toEqual([expect.objectContaining({ code: "not-found", path: "id" })]);
    expect(duplicate.errors).toEqual([
      expect.objectContaining({ code: "already-exists", path: "node.id" })
    ]);
    expect(missing.graph).toBe(source);
    expect(duplicate.graph).toBe(source);
  });
});

describe("atomic graph batches", () => {
  it("commits a valid multi-command batch", () => {
    const source = graphFixture();
    const result = expectSuccess(
      applyGraphBatch(
        source,
        [
          {
            type: "add-node",
            timestamp: NEXT_TIMESTAMP,
            node: createGraphNode({
              id: "concept:mathematics",
              type: "concept",
              label: "Mathematics",
              properties: { name: "Mathematics" },
              createdAt: NEXT_TIMESTAMP
            })
          },
          {
            type: "add-edge",
            timestamp: NEXT_TIMESTAMP,
            edge: createGraphEdge({
              id: "edge:ada-mathematics",
              type: "connected-to",
              source: "person:ada",
              target: "concept:mathematics",
              createdAt: NEXT_TIMESTAMP
            })
          },
          {
            type: "move-nodes",
            timestamp: NEXT_TIMESTAMP,
            positions: { "concept:mathematics": { x: 600, y: 100 } }
          }
        ],
        { label: "Add mathematics", timestamp: NEXT_TIMESTAMP }
      )
    );

    expect(result.graph.nodes.map((node) => node.id)).toContain("concept:mathematics");
    expect(result.graph.edges.map((edge) => edge.id)).toContain("edge:ada-mathematics");
    expect(result.effects.addedNodeIds).toEqual(["concept:mathematics"]);
    expect(result.effects.addedEdgeIds).toEqual(["edge:ada-mathematics"]);
    expect(result.effects.movedNodeIds).toEqual(["concept:mathematics"]);
    expect(source.nodes).toHaveLength(3);
    expect(source.edges).toHaveLength(2);
  });

  it("rolls back the entire batch when a child command fails", () => {
    const source = graphFixture();
    const commands: GraphCommand[] = [
      {
        type: "add-node",
        timestamp: NEXT_TIMESTAMP,
        node: createGraphNode({
          id: "concept:temporary",
          type: "concept",
          label: "Temporary",
          properties: { name: "Temporary" },
          createdAt: NEXT_TIMESTAMP
        })
      },
      {
        type: "add-edge",
        timestamp: NEXT_TIMESTAMP,
        edge: createGraphEdge({
          id: "edge:dangling",
          type: "connected-to",
          source: "concept:temporary",
          target: "node:missing",
          createdAt: NEXT_TIMESTAMP
        })
      },
      {
        type: "remove-node",
        id: "person:ada",
        timestamp: NEXT_TIMESTAMP
      }
    ];
    const result = expectRejection(applyGraphBatch(source, commands, { label: "Rejected batch" }));

    expect(result.graph).toBe(source);
    expect(result.errors[0]).toMatchObject({
      code: "batch-failed",
      commandIndex: 1,
      path: "commands[1]"
    });
    expect(result.errors.map((error) => error.code)).toContain("validation-failed");
    expect(source.nodes.map((node) => node.id)).not.toContain("concept:temporary");
    expect(source.nodes.map((node) => node.id)).toContain("person:ada");
  });

  it("rejects commands when the source graph is already invalid", () => {
    const source = graphFixture();
    source.edges[0].target = "org:missing";
    const result = expectRejection(
      applyGraphCommand(source, {
        type: "set-viewport",
        viewport: null
      })
    );

    expect(result.errors[0]).toMatchObject({ code: "source-invalid" });
    expect(result.errors[0].validation?.map((error) => error.code)).toContain("dangling-edge");
    expect(result.graph).toBe(source);
  });

  it("rejects unknown command types without changing the graph", () => {
    const source = graphFixture();
    const result = expectRejection(
      applyGraphCommand(source, { type: "explode-graph" } as unknown as GraphCommand)
    );

    expect(result.errors).toEqual([
      expect.objectContaining({ code: "invalid-command", path: "type" })
    ]);
    expect(result.graph).toBe(source);
  });
});
