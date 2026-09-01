import { describe, expect, it } from "vitest";
import {
  LARGE_GRAPH_CLASS,
  LARGE_GRAPH_ELEMENT_THRESHOLD,
  VERY_LARGE_GRAPH_CLASS,
  VERY_LARGE_GRAPH_ELEMENT_THRESHOLD,
  graphPerformanceClasses,
  graphPerformanceTier
} from "./graph-performance";

describe("graph performance tiers", () => {
  it("keeps ordinary graphs on the full-detail style", () => {
    expect(graphPerformanceTier(LARGE_GRAPH_ELEMENT_THRESHOLD - 1)).toBe("normal");
    expect(graphPerformanceClasses(LARGE_GRAPH_ELEMENT_THRESHOLD - 1)).toEqual([]);
  });

  it("switches large graphs to simplified edge and label rendering", () => {
    expect(graphPerformanceTier(LARGE_GRAPH_ELEMENT_THRESHOLD)).toBe("large");
    expect(graphPerformanceClasses(LARGE_GRAPH_ELEMENT_THRESHOLD)).toEqual([LARGE_GRAPH_CLASS]);
  });

  it("adds the aggressive LOD class for very large graphs", () => {
    expect(graphPerformanceTier(VERY_LARGE_GRAPH_ELEMENT_THRESHOLD)).toBe("very-large");
    expect(graphPerformanceClasses(VERY_LARGE_GRAPH_ELEMENT_THRESHOLD)).toEqual([
      LARGE_GRAPH_CLASS,
      VERY_LARGE_GRAPH_CLASS
    ]);
  });
});
