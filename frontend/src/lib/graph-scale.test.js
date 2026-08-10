import { describe, expect, it } from "vitest";
import {
  FORCE_LAYOUT_NODE_LIMIT,
  estimateGraphLoad,
  graphRenderDecision,
  safeInitialLayout
} from "./graph-scale";

describe("graph scale policy", () => {
  it("counts expanded relation edges and unresolved endpoints before building", () => {
    const documents = [
      { _id: "a", dtype: "person", related_ids: ["missing"] },
      {
        _id: "r",
        dtype: "relation",
        data: { subject: ["a", "b"], object: ["c", "d"] }
      }
    ];

    expect(estimateGraphLoad(documents)).toEqual({
      documents: 2,
      nodes: 5,
      edges: 5,
      elements: 10
    });
  });

  it("keeps graphs above the old hard cutoffs renderable", () => {
    const documents = Array.from({ length: 2_001 }, (_, index) => ({
      _id: `node:${index}`,
      dtype: "entity"
    }));

    expect(graphRenderDecision(documents)).toMatchObject({
      allowed: true,
      mode: "large",
      exceeded: ["documents", "nodes"]
    });
  });

  it("still reports which advisory scale thresholds were crossed", () => {
    const documents = [
      {
        _id: "r",
        dtype: "relation",
        data: {
          subject: Array.from({ length: 100 }, (_, index) => `s:${index}`),
          object: Array.from({ length: 100 }, (_, index) => `o:${index}`)
        }
      }
    ];

    expect(graphRenderDecision(documents)).toMatchObject({
      allowed: true,
      mode: "large",
      exceeded: ["elements"],
      estimate: { documents: 1, nodes: 200, edges: 10_000, elements: 10_200 }
    });
  });

  it("uses a linear layout when force layout crosses the benchmark cutoff", () => {
    expect(safeInitialLayout("cose", FORCE_LAYOUT_NODE_LIMIT)).toBe("cose");
    expect(safeInitialLayout("cose", FORCE_LAYOUT_NODE_LIMIT + 1)).toBe("grid");
    expect(safeInitialLayout("circle", FORCE_LAYOUT_NODE_LIMIT + 1)).toBe("circle");
  });
});
