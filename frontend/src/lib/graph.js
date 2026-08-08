import { documentLabel } from "starintel_doc";
import { resolveDatasetScope } from "./dataset-url-scope";
import { researchNodeGraphData } from "./research-node-graph";

export const DTYPE_COLORS = Object.freeze({
  person: "#38bdf8",
  org: "#a78bfa",
  entity: "#60a5fa",
  relation: "#94a3b8",
  event: "#f59e0b",
  meeting: "#f59e0b",
  contract: "#22c55e",
  procurement: "#22c55e",
  grant: "#10b981",
  "lobbying-filing": "#fb7185",
  "campaign-finance": "#f97316",
  "investigation-target": "#ef4444",
  target: "#ef4444",
  claim: "#eab308",
  analysis: "#06b6d4",
  "research-pass": "#0ea5e9",
  "research-node": "#ec4899",
  domain: "#14b8a6",
  host: "#2dd4bf",
  network: "#0d9488",
  url: "#60a5fa",
  location: "#84cc16",
  address: "#84cc16",
  document: "#94a3b8",
  unresolved: "#64748b"
});

export const DTYPE_SHAPES = Object.freeze({
  person: "ellipse",
  org: "round-rectangle",
  entity: "ellipse",
  event: "diamond",
  meeting: "diamond",
  relation: "round-tag",
  "investigation-target": "hexagon",
  target: "hexagon",
  claim: "triangle",
  analysis: "pentagon",
  "research-node": "round-hexagon",
  domain: "round-hexagon",
  host: "rectangle",
  network: "octagon",
  url: "tag",
  document: "round-rectangle",
  unresolved: "ellipse"
});

const REVIEWED_VERIFICATION_STATUSES = new Set([
  "reviewed",
  "verified",
  "approved",
  "accepted",
  "confirmed",
  "complete",
  "completed"
]);

const ENTITY_DTYPES = new Set(["entity", "person", "org"]);
const EVENT_DTYPES = new Set(["event", "meeting"]);
const TARGET_DTYPES = new Set(["investigation-target", "target"]);

function normalizedStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replaceAll(" ", "-");
}

export function reviewState(document) {
  const verification = document?.verification || {};
  if (verification.verified === true) return "reviewed";
  if (verification.verified === false) return "unreviewed";
  if (REVIEWED_VERIFICATION_STATUSES.has(normalizedStatus(verification.status))) return "reviewed";
  if (verification.last_reviewed_at) return "reviewed";
  return "unreviewed";
}

export function partitionDocumentsByReview(documents = []) {
  const reviewed = [];
  const unreviewed = [];
  for (const document of documents) {
    (reviewState(document) === "reviewed" ? reviewed : unreviewed).push(document);
  }
  return { reviewed, unreviewed };
}

function countBy(documents, field) {
  const counts = {};
  for (const document of documents) {
    const value = document?.[field] || "unknown";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

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

export function normalizeDirected(value) {
  if (value === false || value === "false") return false;
  return true;
}

function relationParts(document) {
  const data = document.data || {};
  return {
    subjects: endpointIds(data.subject || data.source),
    objects: endpointIds(data.object || data.target),
    predicate: data.predicate || data.relation_type || document.title || "related-to",
    directed: normalizeDirected(data.directed),
    confidence: data.confidence ?? document.assessment?.confidence ?? null
  };
}

function nodeData(document, position) {
  const dtype = document.dtype || "document";
  const label = documentLabel(document);
  const research = researchNodeGraphData(document, label);
  return {
    group: "nodes",
    data: {
      id: document._id,
      label,
      dtype,
      ...(research || {}),
      dataset: document.dataset || "unknown",
      reviewState: reviewState(document),
      document,
      unresolved: false,
      color: DTYPE_COLORS[dtype] || "#94a3b8",
      shape: DTYPE_SHAPES[dtype] || "ellipse"
    },
    ...(position ? { position } : {})
  };
}

function unresolvedNode(id) {
  return {
    group: "nodes",
    data: {
      id,
      label: id,
      dtype: "unresolved",
      dataset: "unresolved",
      reviewState: "unresolved",
      unresolved: true,
      color: DTYPE_COLORS.unresolved,
      shape: DTYPE_SHAPES.unresolved
    }
  };
}

export function buildGraph(documents, positions = {}) {
  const entities = documents.filter((document) => document.dtype !== "relation");
  const nodes = new Map(
    entities.map((document) => [document._id, nodeData(document, positions[document._id])])
  );
  const edges = [];

  for (const relation of documents.filter((document) => document.dtype === "relation")) {
    const { subjects, objects, predicate, directed, confidence } = relationParts(relation);
    for (const source of subjects) {
      for (const target of objects) {
        if (!nodes.has(source)) nodes.set(source, unresolvedNode(source));
        if (!nodes.has(target)) nodes.set(target, unresolvedNode(target));
        edges.push({
          group: "edges",
          data: {
            id: `${relation._id}:${source}:${target}`,
            relationId: relation._id,
            source,
            target,
            label: predicate,
            predicate,
            dataset: relation.dataset || "unknown",
            reviewState: reviewState(relation),
            directed,
            confidence,
            document: relation
          }
        });
      }
    }
  }

  for (const document of entities) {
    for (const target of document.related_ids || []) {
      if (!nodes.has(target)) nodes.set(target, unresolvedNode(target));
      edges.push({
        group: "edges",
        data: {
          id: `related:${document._id}:${target}`,
          relationId: null,
          source: document._id,
          target,
          label: "related",
          predicate: "related",
          dataset: document.dataset || "unknown",
          reviewState: reviewState(document),
          directed: false,
          confidence: null
        }
      });
    }
  }

  return { nodes: [...nodes.values()], edges, elements: [...nodes.values(), ...edges] };
}

export function filterGraph(graph, queryOrFilters = "", legacyDtype = "") {
  const filters =
    typeof queryOrFilters === "object" && queryOrFilters !== null
      ? queryOrFilters
      : { query: queryOrFilters, dtype: legacyDtype };
  const { query = "", dtype = "", dataset = "", predicate = "" } = filters;
  const effectiveDataset = resolveDatasetScope(dataset);

  const needle = query.trim().toLowerCase();
  const candidateNodes = graph.nodes.filter((node) => {
    if (dtype && node.data.dtype !== dtype) return false;
    if (effectiveDataset && node.data.dataset !== effectiveDataset) return false;
    if (!needle) return true;
    return [
      node.data.id,
      node.data.label,
      node.data.dtype,
      node.data.dataset,
      node.data.document?.summary,
      node.data.document?.title
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
  const candidateIds = new Set(candidateNodes.map((node) => node.data.id));
  const edges = graph.edges.filter(
    (edge) =>
      candidateIds.has(edge.data.source) &&
      candidateIds.has(edge.data.target) &&
      (!effectiveDataset || edge.data.dataset === effectiveDataset) &&
      (!predicate || edge.data.predicate === predicate)
  );
  const visibleIds = predicate
    ? new Set(edges.flatMap((edge) => [edge.data.source, edge.data.target]))
    : candidateIds;
  const nodes = candidateNodes.filter((node) => visibleIds.has(node.data.id));
  return { nodes, edges, elements: [...nodes, ...edges] };
}

export function importedGraphNodeIds(graph, importedIds = []) {
  const imported = new Set(importedIds);
  const focused = new Set(graph.nodes.map((node) => node.data.id).filter((id) => imported.has(id)));
  for (const edge of graph.edges) {
    if (!imported.has(edge.data.relationId)) continue;
    focused.add(edge.data.source);
    focused.add(edge.data.target);
  }
  return [...focused];
}

export function graphStatistics(documents, graph = null) {
  const { reviewed, unreviewed } = partitionDocumentsByReview(documents);
  const reviewedGraph = graph || buildGraph(reviewed);
  const byStatus = {};
  let sourceCount = 0;
  let evidenceCount = 0;

  for (const document of reviewed) {
    const status =
      document.verification?.status || (document.verification?.verified ? "verified" : "reviewed");
    byStatus[status] = (byStatus[status] || 0) + 1;
    sourceCount += document.sources?.length || 0;
    evidenceCount += document.evidence?.length || 0;
  }

  const degree = new Map(reviewedGraph.nodes.map((node) => [node.data.id, 0]));
  reviewedGraph.edges.forEach((edge) => {
    degree.set(edge.data.source, (degree.get(edge.data.source) || 0) + 1);
    degree.set(edge.data.target, (degree.get(edge.data.target) || 0) + 1);
  });
  const topConnected = [...degree.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([id, count]) => ({
      id,
      count,
      label: reviewedGraph.nodes.find((node) => node.data.id === id)?.data.label || id
    }));

  const reviewedRelations = reviewed.filter((document) => document.dtype === "relation").length;

  return {
    documents: documents.length,
    reviewedDocuments: reviewed.length,
    unreviewedDocuments: unreviewed.length,
    reviewedEntities: reviewed.filter((document) => ENTITY_DTYPES.has(document.dtype)).length,
    reviewedRelations,
    reviewedEvents: reviewed.filter((document) => EVENT_DTYPES.has(document.dtype)).length,
    reviewedInvestigationTargets: reviewed.filter((document) => TARGET_DTYPES.has(document.dtype))
      .length,
    reviewPercent: documents.length ? Math.round((reviewed.length / documents.length) * 100) : 0,
    nodes: reviewedGraph.nodes.length,
    edges: reviewedGraph.edges.length,
    relations: reviewedRelations,
    sources: sourceCount,
    evidence: evidenceCount,
    unresolvedNodes: reviewedGraph.nodes.filter((node) => node.data.unresolved).length,
    byDtype: countBy(reviewed, "dtype"),
    byDataset: countBy(reviewed, "dataset"),
    byStatus,
    reviewedByDtype: countBy(reviewed, "dtype"),
    reviewedByDataset: countBy(reviewed, "dataset"),
    unreviewedByDtype: countBy(unreviewed, "dtype"),
    unreviewedByDataset: countBy(unreviewed, "dataset"),
    topConnected
  };
}

function edgeCost(edge) {
  const confidence = Number(edge.data.confidence);
  return 1 + (Number.isFinite(confidence) ? 1 - confidence : 0.5);
}

export function findPaths(graph, startId, endId, limit = 5, maxDepth = 8) {
  if (!startId || !endId || startId === endId) return [];
  const adjacency = new Map(graph.nodes.map((node) => [node.data.id, []]));
  graph.edges.forEach((edge) => {
    adjacency.get(edge.data.source)?.push({ edge, next: edge.data.target });
    adjacency.get(edge.data.target)?.push({ edge, next: edge.data.source });
  });
  if (!adjacency.has(startId) || !adjacency.has(endId)) return [];

  const queue = [{ nodes: [startId], edges: [], cost: 0 }];
  const results = [];
  let expansions = 0;
  while (queue.length && results.length < limit && expansions < 10000) {
    queue.sort((left, right) => left.edges.length - right.edges.length || left.cost - right.cost);
    const path = queue.shift();
    const current = path.nodes.at(-1);
    if (current === endId) {
      results.push(path);
      continue;
    }
    if (path.edges.length >= maxDepth) continue;
    for (const candidate of adjacency.get(current) || []) {
      if (path.nodes.includes(candidate.next)) continue;
      queue.push({
        nodes: [...path.nodes, candidate.next],
        edges: [...path.edges, candidate.edge],
        cost: path.cost + edgeCost(candidate.edge)
      });
    }
    expansions += 1;
  }
  return results.sort(
    (left, right) => left.edges.length - right.edges.length || left.cost - right.cost
  );
}
