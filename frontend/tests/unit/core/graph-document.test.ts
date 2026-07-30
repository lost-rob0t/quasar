import { describe, expect, it } from "vitest";
import {
  GraphValidationError,
  TypeRegistry,
  TypeRegistryError,
  assertGraphDocument,
  cloneGraphDocument,
  createDefaultTypeRegistry,
  createGraphDocument,
  createGraphEdge,
  createGraphNode,
  graphDocumentFromDocuments,
  validateGraphDocument
} from "../../../src/core";
import {
  FIXTURE_TIMESTAMP,
  smallTypedGraphFixture,
  unknownTypeGraphFixture
} from "../../../src/testing/graph-fixtures";

function blankGraph() {
  return createGraphDocument({
    id: "graph:test",
    name: "Test graph",
    timestamp: FIXTURE_TIMESTAMP
  });
}

describe("canonical graph document", () => {
  it("creates and validates a blank graph", () => {
    const graph = blankGraph();
    const result = validateGraphDocument(graph);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(graph).toMatchObject({
      schemaVersion: "1.0.0",
      id: "graph:test",
      nodes: [],
      edges: [],
      view: { layout: "preset", viewport: null, selectedIds: [] }
    });
    expect(() => assertGraphDocument(graph)).not.toThrow();
  });

  it("converts the deterministic typed fixture into a valid canonical graph", () => {
    const fixture = smallTypedGraphFixture();
    const workspace = fixture.workspace.graphs[0];
    const graph = graphDocumentFromDocuments(fixture.documents, {
      id: "graph:cross-dataset-investigation",
      name: workspace.name,
      timestamp: FIXTURE_TIMESTAMP,
      positions: workspace.positions,
      viewport: workspace.viewport,
      layout: workspace.layout,
      selectedIds: workspace.selectedIds
    });
    const result = validateGraphDocument(graph);

    expect(result.errors).toEqual([]);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
    expect(graph.nodes.find((node) => node.id === "starintel:person:ada")?.position).toEqual({
      x: 0,
      y: 0
    });
    expect(graph.edges.map((edge) => edge.type)).toEqual(["member-of", "participated-in"]);
  });

  it("accepts unknown types and preserves extension fields", () => {
    const fixture = unknownTypeGraphFixture();
    const graph = graphDocumentFromDocuments(fixture.documents, {
      id: "graph:future-data",
      name: "Future data",
      timestamp: FIXTURE_TIMESTAMP,
      extensions: { futureGraphField: { enabled: true } }
    });
    const registry = createDefaultTypeRegistry();
    const result = validateGraphDocument(graph, registry);
    const roundTrip = JSON.parse(JSON.stringify(graph));

    expect(result.valid).toBe(true);
    expect(registry.resolveNodeType("future-entity")).toMatchObject({
      id: "future-entity",
      unknown: true
    });
    expect(roundTrip.nodes[0].extensions.starintelDocument.fixture_extension).toBe("preserve-me");
    expect(roundTrip.extensions.futureGraphField).toEqual({ enabled: true });
  });

  it("rejects invalid identifiers, duplicate IDs, and dangling edges", () => {
    const graph = blankGraph();
    graph.id = "bad graph id";
    graph.nodes.push(
      createGraphNode({
        id: "node:one",
        type: "entity",
        label: "One",
        createdAt: FIXTURE_TIMESTAMP
      }),
      createGraphNode({
        id: "node:one",
        type: "entity",
        label: "Duplicate",
        createdAt: FIXTURE_TIMESTAMP
      })
    );
    graph.edges.push(
      createGraphEdge({
        id: "node:one",
        type: "connected-to",
        source: "node:one",
        target: "node:missing",
        createdAt: FIXTURE_TIMESTAMP
      })
    );

    const result = validateGraphDocument(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["invalid-identifier", "duplicate-id", "dangling-edge"])
    );
    expect(() => assertGraphDocument(graph)).toThrow(GraphValidationError);
  });

  it("enforces edge endpoint constraints", () => {
    const graph = createGraphDocument({
      id: "graph:endpoint-test",
      name: "Endpoint test",
      timestamp: FIXTURE_TIMESTAMP,
      nodes: [
        createGraphNode({
          id: "org:one",
          type: "org",
          label: "Organization",
          createdAt: FIXTURE_TIMESTAMP
        }),
        createGraphNode({
          id: "person:one",
          type: "person",
          label: "Person",
          createdAt: FIXTURE_TIMESTAMP
        })
      ],
      edges: [
        createGraphEdge({
          id: "edge:wrong-direction",
          type: "member-of",
          source: "org:one",
          target: "person:one",
          createdAt: FIXTURE_TIMESTAMP
        })
      ]
    });

    const result = validateGraphDocument(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.filter((error) => error.code === "endpoint-violation")).toHaveLength(2);
  });

  it("validates required typed properties with a custom registry", () => {
    const registry = new TypeRegistry({
      nodeTypes: [
        {
          kind: "node",
          id: "asset",
          label: "Asset",
          properties: [
            { key: "name", label: "Name", valueType: "string", required: true },
            { key: "risk", label: "Risk", valueType: "number" }
          ]
        }
      ]
    });
    const graph = createGraphDocument({
      id: "graph:property-test",
      name: "Property test",
      timestamp: FIXTURE_TIMESTAMP,
      nodes: [
        createGraphNode({
          id: "asset:one",
          type: "asset",
          label: "Asset one",
          properties: { risk: "high" },
          createdAt: FIXTURE_TIMESTAMP
        })
      ]
    });

    const result = validateGraphDocument(graph, registry);

    expect(result.errors.filter((error) => error.code === "invalid-property")).toHaveLength(2);
  });

  it("clones graph data without sharing mutable extension objects", () => {
    const graph = createGraphDocument({
      id: "graph:clone-test",
      name: "Clone test",
      timestamp: FIXTURE_TIMESTAMP,
      extensions: { nested: { value: 1 } }
    });
    const clone = cloneGraphDocument(graph);
    const nested = clone.extensions.nested as { value: number };
    nested.value = 2;

    expect((graph.extensions.nested as { value: number }).value).toBe(1);
    expect(nested.value).toBe(2);
  });
});

describe("type registry", () => {
  it("rejects duplicate type and property identifiers", () => {
    expect(
      () =>
        new TypeRegistry({
          nodeTypes: [
            { kind: "node", id: "person", label: "Person", properties: [] },
            { kind: "node", id: "person", label: "Duplicate", properties: [] }
          ]
        })
    ).toThrow(TypeRegistryError);

    expect(
      () =>
        new TypeRegistry({
          nodeTypes: [
            {
              kind: "node",
              id: "asset",
              label: "Asset",
              properties: [
                { key: "name", label: "Name", valueType: "string" },
                { key: "name", label: "Duplicate", valueType: "string" }
              ]
            }
          ]
        })
    ).toThrow(TypeRegistryError);
  });

  it("lists registered types deterministically", () => {
    const registry = new TypeRegistry({
      nodeTypes: [
        { kind: "node", id: "zeta", label: "Zeta", properties: [] },
        { kind: "node", id: "alpha", label: "Alpha", properties: [] }
      ]
    });

    expect(registry.listNodeTypes().map((definition) => definition.id)).toEqual(["alpha", "zeta"]);
  });
});
