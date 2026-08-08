export const GRAPH_RENDER_LIMITS = Object.freeze({
  maxDocuments: 5_000,
  maxNodes: 4_000,
  maxElements: 8_000
});

export const FORCE_LAYOUT_NODE_LIMIT = 250;

function endpointId(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return value.id || value.entity_id || value.document_id || value.external_id || null;
}

function endpointIds(value) {
  if (Array.isArray(value)) return value.map(endpointId).filter(Boolean);
  const id = endpointId(value);
  return id ? [id] : [];
}

export function estimateGraphLoad(documents = []) {
  const nodeIds = new Set();
  let edges = 0;

  for (const document of documents) {
    if (document?.dtype === "relation") {
      const data = document.data || {};
      const subjects = endpointIds(data.subject || data.source);
      const objects = endpointIds(data.object || data.target);
      subjects.forEach((id) => nodeIds.add(id));
      objects.forEach((id) => nodeIds.add(id));
      edges += subjects.length * objects.length;
      continue;
    }

    if (document?._id) nodeIds.add(document._id);
    for (const target of document?.related_ids || []) {
      const id = endpointId(target);
      if (!id) continue;
      nodeIds.add(id);
      edges += 1;
    }
  }

  return {
    documents: documents.length,
    nodes: nodeIds.size,
    edges,
    elements: nodeIds.size + edges
  };
}

export function graphRenderDecision(documents = [], limits = GRAPH_RENDER_LIMITS) {
  const estimate = estimateGraphLoad(documents);
  const exceeded = [];
  if (estimate.documents > limits.maxDocuments) exceeded.push("documents");
  if (estimate.nodes > limits.maxNodes) exceeded.push("nodes");
  if (estimate.elements > limits.maxElements) exceeded.push("elements");
  return { allowed: exceeded.length === 0, exceeded, estimate, limits };
}

export function safeInitialLayout(layout, nodeCount) {
  const requested = layout || "cose";
  return requested === "cose" && nodeCount > FORCE_LAYOUT_NODE_LIMIT ? "grid" : requested;
}
