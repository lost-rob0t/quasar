export const MALTEGO_LAYOUTS = Object.freeze([
  { id: "block", label: "Block" },
  { id: "hierarchical", label: "Hierarchical" },
  { id: "circular", label: "Circular" },
  { id: "organic", label: "Organic" },
  { id: "interactive-organic", label: "Interactive Organic" },
  { id: "orthogonal", label: "Orthogonal" }
]);

const LEGACY_LAYOUTS = Object.freeze({
  breadthfirst: "hierarchical",
  circle: "circular",
  concentric: "circular",
  cose: "organic",
  grid: "orthogonal"
});

export function normalizeMaltegoLayout(layout) {
  const value = String(layout || "")
    .trim()
    .toLowerCase();
  if (MALTEGO_LAYOUTS.some((candidate) => candidate.id === value)) return value;
  return LEGACY_LAYOUTS[value] || "organic";
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nodeWeight(node) {
  const document = node.data("document") || {};
  return asNumber(
    document.weight ?? document.data?.weight ?? document.assessment?.weight ?? node.data("weight"),
    0
  );
}

function compareNodes(left, right) {
  const typeOrder = String(left.data("dtype") || "").localeCompare(
    String(right.data("dtype") || "")
  );
  if (typeOrder) return typeOrder;

  const weightOrder = nodeWeight(right) - nodeWeight(left);
  if (weightOrder) return weightOrder;

  return String(left.data("label") || left.id()).localeCompare(
    String(right.data("label") || right.id())
  );
}

function layoutElements(cy, options) {
  if (typeof options.eles === "string") return cy.$(options.eles);
  return options.eles || cy.elements();
}

function directedEdges(elements) {
  return elements.edges().filter((edge) => edge.data("directed") !== false);
}

function hierarchyRoots(elements) {
  const nodes = elements.nodes();
  const edges = directedEdges(elements);
  if (!nodes.length) return nodes;

  const incoming = new Map(nodes.map((node) => [node.id(), 0]));
  edges.forEach((edge) =>
    incoming.set(edge.target().id(), (incoming.get(edge.target().id()) || 0) + 1)
  );

  const roots = nodes.filter((node) => (incoming.get(node.id()) || 0) === 0);
  if (roots.length) return roots;

  const minimum = Math.min(...nodes.map((node) => incoming.get(node.id()) || 0));
  return nodes.filter((node) => (incoming.get(node.id()) || 0) === minimum);
}

function hierarchyDepths(elements) {
  const nodes = elements.nodes();
  const edges = directedEdges(elements);
  const depth = new Map(nodes.map((node) => [node.id(), Number.POSITIVE_INFINITY]));
  const adjacency = new Map(nodes.map((node) => [node.id(), []]));

  edges.forEach((edge) => adjacency.get(edge.source().id())?.push(edge.target().id()));

  const queue = [];
  hierarchyRoots(elements).forEach((root) => {
    depth.set(root.id(), 0);
    queue.push(root.id());
  });

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    const nextDepth = (depth.get(id) || 0) + 1;
    for (const target of adjacency.get(id) || []) {
      if (nextDepth >= depth.get(target)) continue;
      depth.set(target, nextDepth);
      queue.push(target);
    }
  }

  let disconnectedDepth = Math.max(0, ...[...depth.values()].filter(Number.isFinite)) + 1;
  nodes
    .toArray()
    .sort(compareNodes)
    .forEach((node) => {
      if (Number.isFinite(depth.get(node.id()))) return;
      depth.set(node.id(), disconnectedDepth);
      disconnectedDepth += 1;
    });

  return depth;
}

export function blockPositions(elements) {
  const nodes = elements.nodes();
  const depth = hierarchyDepths(elements);
  const layers = new Map();

  nodes.forEach((node) => {
    const level = depth.get(node.id()) || 0;
    if (!layers.has(level)) layers.set(level, []);
    layers.get(level).push(node);
  });

  const positions = {};
  const levels = [...layers.keys()].sort((left, right) => left - right);
  const widest = Math.max(1, ...levels.map((level) => layers.get(level).length));
  const columnGap = 150;
  const rowGap = 135;

  levels.forEach((level, levelIndex) => {
    const layer = layers.get(level).sort(compareNodes);
    const isBottom = levelIndex === levels.length - 1;
    const columns = isBottom
      ? Math.max(1, Math.ceil(Math.sqrt(layer.length)))
      : Math.max(1, layer.length);
    const width = (columns - 1) * columnGap;
    const baseX = ((widest - 1) * columnGap - width) / 2;
    const baseY = levelIndex * rowGap;

    layer.forEach((node, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      positions[node.id()] = {
        x: baseX + column * columnGap,
        y: baseY + row * rowGap
      };
    });
  });

  return positions;
}

export function maltegoLayoutOptions(cy, options = {}) {
  const name = String(options.name || "").toLowerCase();
  const elements = layoutElements(cy, options);

  switch (name) {
    case "block":
      return {
        ...options,
        name: "preset",
        eles: elements,
        positions: blockPositions(elements),
        fit: options.fit !== false,
        padding: options.padding ?? 60
      };
    case "hierarchical":
      return {
        ...options,
        name: "breadthfirst",
        eles: elements,
        directed: true,
        direction: "downward",
        circle: false,
        grid: true,
        roots: hierarchyRoots(elements),
        spacingFactor: 1.3,
        padding: options.padding ?? 60
      };
    case "circular":
      return {
        ...options,
        name: "concentric",
        eles: elements,
        concentric: (node) => node.degree(false),
        levelWidth: (nodes) => Math.max(1, asNumber(nodes.maxDegree()) / 4),
        minNodeSpacing: 45,
        avoidOverlap: true,
        equidistant: false,
        padding: options.padding ?? 60
      };
    case "organic":
      return {
        ...options,
        name: "cose",
        eles: elements,
        randomize: true,
        idealEdgeLength: () => 90,
        nodeRepulsion: () => 5200,
        componentSpacing: 90,
        padding: options.padding ?? 60
      };
    case "interactive-organic":
      return {
        ...options,
        name: "cose",
        eles: elements,
        randomize: false,
        idealEdgeLength: () => 90,
        nodeRepulsion: () => 4600,
        componentSpacing: 100,
        initialTemp: 60,
        numIter: 450,
        padding: options.padding ?? 60
      };
    case "orthogonal":
      return {
        ...options,
        name: "grid",
        eles: elements,
        sort: compareNodes,
        condense: true,
        avoidOverlap: true,
        avoidOverlapPadding: 28,
        spacingFactor: 1.15,
        padding: options.padding ?? 60
      };
    default:
      return options;
  }
}

export function installMaltegoLayouts(cy) {
  if (cy.scratch("quasarMaltegoLayouts")) return cy;

  const nativeLayout = cy.layout.bind(cy);
  cy.layout = (options) => nativeLayout(maltegoLayoutOptions(cy, options));
  cy.scratch("quasarMaltegoLayouts", true);
  return cy;
}
