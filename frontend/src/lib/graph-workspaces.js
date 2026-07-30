const DEFAULT_GRAPH_ID = "all-documents";
const MAX_GRAPHS = 100;

function uniqueStrings(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function cleanPositions(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanGroups(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([id, group]) => [
      id,
      {
        id,
        name: String(group?.name || id),
        documentIds: uniqueStrings(group?.documentIds),
        collapsed: Boolean(group?.collapsed)
      }
    ])
  );
}

function normalizeGraph(graph, fallback = {}) {
  const documentIds =
    graph?.documentIds === null
      ? null
      : uniqueStrings(graph?.documentIds || fallback.documentIds || []);
  const normalized = {
    id: String(graph?.id || fallback.id || "").trim(),
    name: String(graph?.name || fallback.name || "Untitled graph").trim(),
    documentIds,
    positions: cleanPositions(graph?.positions || fallback.positions),
    viewport: graph?.viewport || fallback.viewport || null,
    layout: String(graph?.layout || fallback.layout || "cose"),
    selectedIds: uniqueStrings(graph?.selectedIds || fallback.selectedIds || [])
  };
  if (graph?.groups || fallback.groups)
    normalized.groups = cleanGroups(graph?.groups || fallback.groups);
  return normalized;
}

function generatedGraphId(name) {
  const slug =
    String(name || "graph")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "graph";
  const suffix = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${slug}-${suffix}`;
}

export function normalizeGraphWorkspace(input = {}) {
  const legacy = normalizeGraph({
    id: DEFAULT_GRAPH_ID,
    name: "All documents",
    documentIds: null,
    positions: input.positions,
    viewport: input.viewport,
    layout: input.layout,
    selectedIds: input.selectedIds
  });
  const rawGraphs = Array.isArray(input.graphs) && input.graphs.length ? input.graphs : [legacy];
  const seen = new Set();
  const graphs = [];

  for (const rawGraph of rawGraphs.slice(0, MAX_GRAPHS)) {
    const graph = normalizeGraph(rawGraph);
    if (!graph.id || seen.has(graph.id)) continue;
    seen.add(graph.id);
    graphs.push(graph);
  }
  if (!graphs.length) graphs.push(legacy);

  const activeGraphId = graphs.some((graph) => graph.id === input.activeGraphId)
    ? input.activeGraphId
    : graphs[0].id;
  const active = graphs.find((graph) => graph.id === activeGraphId);

  return {
    ...input,
    graphs,
    activeGraphId,
    positions: active.positions,
    viewport: active.viewport,
    layout: active.layout,
    selectedIds: active.selectedIds,
    ...(active.groups ? { groups: active.groups } : {})
  };
}

export function getActiveGraph(workspace) {
  const normalized = normalizeGraphWorkspace(workspace);
  return normalized.graphs.find((graph) => graph.id === normalized.activeGraphId);
}

export function activeGraphMembershipKey(workspace) {
  const documentIds = getActiveGraph(workspace).documentIds;
  return documentIds === null ? "*" : JSON.stringify([...documentIds].sort());
}

export function updateActiveGraph(workspace, changes = {}) {
  const normalized = normalizeGraphWorkspace(workspace);
  const graphs = normalized.graphs.map((graph) =>
    graph.id === normalized.activeGraphId ? normalizeGraph({ ...graph, ...changes }, graph) : graph
  );
  return normalizeGraphWorkspace({ ...normalized, graphs });
}

export function addDocumentsToActiveGraph(workspace, ids, changes = {}) {
  const normalized = normalizeGraphWorkspace(workspace);
  const active = getActiveGraph(normalized);
  const documentIds =
    active.documentIds === null
      ? null
      : uniqueStrings([...active.documentIds, ...uniqueStrings(ids)]);
  return updateActiveGraph(normalized, { ...changes, documentIds });
}

export function removeDocumentsFromActiveGraph(workspace, ids) {
  const normalized = normalizeGraphWorkspace(workspace);
  const active = getActiveGraph(normalized);
  if (active.documentIds === null)
    throw new Error("Documents cannot be removed from the All documents graph");
  const removed = new Set(uniqueStrings(ids));
  const documentIds = active.documentIds.filter((id) => !removed.has(id));
  const positions = Object.fromEntries(
    Object.entries(active.positions).filter(([id]) => !removed.has(id))
  );
  const selectedIds = active.selectedIds.filter((id) => !removed.has(id));
  return updateActiveGraph(normalized, { documentIds, positions, selectedIds });
}

export function switchActiveGraph(workspace, id) {
  const normalized = normalizeGraphWorkspace(workspace);
  if (!normalized.graphs.some((graph) => graph.id === id)) throw new Error(`Unknown graph: ${id}`);
  return normalizeGraphWorkspace({ ...normalized, activeGraphId: id });
}

export function createGraph(workspace, name, { id = generatedGraphId(name) } = {}) {
  const normalized = normalizeGraphWorkspace(workspace);
  const cleanName = String(name || "").trim();
  const cleanId = String(id || "").trim();
  if (!cleanName) throw new TypeError("Graph name is required");
  if (!cleanId) throw new TypeError("Graph id is required");
  if (normalized.graphs.length >= MAX_GRAPHS)
    throw new RangeError(`Graph limit reached: ${MAX_GRAPHS}`);
  if (normalized.graphs.some((graph) => graph.id === cleanId))
    throw new Error(`Graph already exists: ${cleanId}`);
  const graph = normalizeGraph({
    id: cleanId,
    name: cleanName,
    documentIds: [],
    positions: {},
    viewport: null,
    layout: "cose",
    selectedIds: []
  });
  return normalizeGraphWorkspace({
    ...normalized,
    graphs: [...normalized.graphs, graph],
    activeGraphId: graph.id
  });
}

export function renameActiveGraph(workspace, name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new TypeError("Graph name is required");
  return updateActiveGraph(workspace, { name: cleanName });
}

export function clearActiveGraph(workspace, { emptyGraphName = "Empty graph" } = {}) {
  const normalized = normalizeGraphWorkspace(workspace);
  const active = getActiveGraph(normalized);
  if (active.documentIds === null) return createGraph(normalized, emptyGraphName);
  return updateActiveGraph(normalized, {
    documentIds: [],
    positions: {},
    viewport: null,
    selectedIds: [],
    groups: {}
  });
}

export function deleteActiveGraph(workspace) {
  const normalized = normalizeGraphWorkspace(workspace);
  if (normalized.graphs.length === 1) throw new Error("The last graph cannot be deleted");
  const index = normalized.graphs.findIndex((graph) => graph.id === normalized.activeGraphId);
  const graphs = normalized.graphs.filter((graph) => graph.id !== normalized.activeGraphId);
  const next = graphs[Math.min(index, graphs.length - 1)];
  return normalizeGraphWorkspace({ ...normalized, graphs, activeGraphId: next.id });
}

export function documentsForActiveGraph(workspace, documents) {
  const active = getActiveGraph(workspace);
  if (active.documentIds === null) return documents;
  const allowed = new Set(active.documentIds);
  return documents.filter((document) => allowed.has(document._id));
}
