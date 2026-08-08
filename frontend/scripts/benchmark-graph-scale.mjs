import cytoscape from "cytoscape";

const sizes = [100, 250, 500, 1_000, 2_000, 4_000, 8_000];
const rows = [];

for (const nodes of sizes) {
  const elements = [];
  for (let index = 0; index < nodes; index += 1) {
    elements.push({ data: { id: `node:${index}` } });
  }
  for (let index = 1; index < nodes; index += 1) {
    elements.push({
      data: { id: `edge:${index}`, source: `node:${index - 1}`, target: `node:${index}` }
    });
  }

  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const graph = cytoscape({ headless: true, elements: [] });
  let started = performance.now();
  graph.add(elements);
  const addMs = performance.now() - started;
  started = performance.now();
  graph.layout({ name: "grid" }).run();
  const gridMs = performance.now() - started;
  let forceMs = null;
  if (nodes <= 1_000) {
    started = performance.now();
    graph.layout({ name: "cose", animate: false, randomize: true, numIter: 200 }).run();
    forceMs = performance.now() - started;
  }
  rows.push({
    nodes,
    elements: elements.length,
    addMs: Number(addMs.toFixed(1)),
    gridMs: Number(gridMs.toFixed(1)),
    force200Ms: forceMs === null ? null : Number(forceMs.toFixed(1)),
    heapMb: Number(((process.memoryUsage().heapUsed - heapBefore) / 1_048_576).toFixed(1))
  });
  graph.destroy();
}

console.table(rows);
