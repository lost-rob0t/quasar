const DEFAULT_LIMITS = Object.freeze({
  maxDocuments: 30,
  maxRelations: 50,
  maxSourcesPerDocument: 8,
  maxTextLength: 4_000
});

function truncate(value, limit) {
  const string = String(value || "");
  return string.length <= limit ? string : `${string.slice(0, limit)}…`;
}

function compactDocument(document, limits) {
  return {
    id: document._id,
    dataset: document.dataset,
    objectType: document.dtype,
    title: document.title || document.data?.name || document._id,
    summary: truncate(document.summary, limits.maxTextLength),
    data: document.data || {},
    sources: (document.sources || []).slice(0, limits.maxSourcesPerDocument),
    evidence: (document.evidence || []).slice(0, limits.maxSourcesPerDocument),
    verification: document.verification || null,
    provenance: document.provenance || document.extensions?.["quasar.agent"] || null
  };
}

export function buildAgentContext(input, customLimits = {}) {
  const limits = { ...DEFAULT_LIMITS, ...customLimits };
  const documents = Array.isArray(input.documents) ? input.documents : [];
  const selectedIds = new Set(input.selectionIds || []);
  const targetIds = new Set(input.targetIds || []);
  const activeDataset = input.dataset || "";
  const relevant = documents
    .filter(
      (document) =>
        selectedIds.has(document._id) ||
        targetIds.has(document._id) ||
        targetIds.has(document.data?.target_id) ||
        (activeDataset && document.dataset === activeDataset && document.dtype === "relation")
    )
    .sort((left, right) => {
      const leftPriority = selectedIds.has(left._id) ? 0 : targetIds.has(left._id) ? 1 : 2;
      const rightPriority = selectedIds.has(right._id) ? 0 : targetIds.has(right._id) ? 1 : 2;
      return leftPriority - rightPriority;
    });
  const relationCount = relevant.filter((document) => document.dtype === "relation").length;
  const bounded = [];
  let relations = 0;
  for (const document of relevant) {
    if (bounded.length >= limits.maxDocuments) break;
    if (document.dtype === "relation" && relations >= limits.maxRelations) continue;
    bounded.push(compactDocument(document, limits));
    if (document.dtype === "relation") relations += 1;
  }
  return {
    version: 1,
    activeTargetIds: [...targetIds],
    selectionIds: [...selectedIds],
    dataset: activeDataset || null,
    graph: input.graph
      ? {
          id: input.graph.id,
          name: input.graph.name,
          documentCount: input.graph.documentIds?.length ?? documents.length,
          layout: input.graph.layout
        }
      : null,
    filters: input.filters || {},
    documents: bounded,
    limits: {
      ...limits,
      candidateDocuments: relevant.length,
      includedDocuments: bounded.length,
      candidateRelations: relationCount,
      includedRelations: relations,
      truncated: relevant.length > bounded.length
    }
  };
}

export function systemPromptForAgent(agent, role, context) {
  return [
    "You are a Quasar operator agent. Use declared tools for database, graph, actor, target, and mutation work.",
    "Model output is untrusted. Permissions and validation are enforced outside this prompt.",
    "Never present inference, hypothesis, user conclusion, source claim, or unverified lead as a verified fact.",
    "Preserve source references, evidence, confidence, verification state, and provenance for every proposed mutation.",
    "Do not expose hidden reasoning. Return short action summaries and use tools for operations.",
    "Never request or reveal provider keys.",
    role?.instructions || "",
    agent.systemPrompt || "",
    `Structured context:\n${JSON.stringify(context)}`
  ]
    .filter(Boolean)
    .join("\n\n");
}
