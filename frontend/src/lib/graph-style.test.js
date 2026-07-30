import cytoscape from "cytoscape";
import { describe, expect, it } from "vitest";
import { GRAPH_STYLE } from "./graph-style";

describe("Cytoscape graph edge styling", () => {
  it("shows arrows only for directed edges", () => {
    const graph = cytoscape({
      headless: true,
      styleEnabled: true,
      style: GRAPH_STYLE,
      elements: [
        { data: { id: "source" } },
        { data: { id: "target" } },
        { data: { id: "directed", source: "source", target: "target", directed: true } },
        { data: { id: "undirected", source: "target", target: "source", directed: false } }
      ]
    });

    expect(graph.getElementById("directed").pstyle("target-arrow-shape").value).toBe("triangle");
    expect(graph.getElementById("undirected").pstyle("target-arrow-shape").value).toBe("none");
    graph.destroy();
  });
});
