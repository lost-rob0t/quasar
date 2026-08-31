export const LARGE_GRAPH_ELEMENT_THRESHOLD = 8_000;
export const VERY_LARGE_GRAPH_ELEMENT_THRESHOLD = 32_000;

export const LARGE_GRAPH_CLASS = "graph-performance-large";
export const VERY_LARGE_GRAPH_CLASS = "graph-performance-very-large";

export function graphPerformanceTier(elementCount) {
  const count = Number(elementCount) || 0;
  if (count >= VERY_LARGE_GRAPH_ELEMENT_THRESHOLD) return "very-large";
  if (count >= LARGE_GRAPH_ELEMENT_THRESHOLD) return "large";
  return "normal";
}

export function graphPerformanceClasses(elementCount) {
  const tier = graphPerformanceTier(elementCount);
  if (tier === "very-large") return [LARGE_GRAPH_CLASS, VERY_LARGE_GRAPH_CLASS];
  if (tier === "large") return [LARGE_GRAPH_CLASS];
  return [];
}
