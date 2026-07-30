import { createResearchNode, isResearchNode, normalizeResearchNode } from "./research-nodes";

const STATUS_LABELS = Object.freeze({
  draft: "draft",
  queued: "queued",
  running: "running",
  paused: "paused",
  blocked: "blocked",
  completed: "completed",
  failed: "failed",
  killed: "killed"
});

function uniqueIds(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

export function researchNodeGraphData(document, label) {
  if (!isResearchNode(document)) return null;
  const status = STATUS_LABELS[document.data?.status] || "draft";
  return {
    researchStatus: status,
    researchLabel: `${label}\n[${status}]`
  };
}

export function researchNodeOutputIds(document) {
  if (!isResearchNode(document)) return [];
  return uniqueIds(document.data?.output_ids);
}

export function researchNodeScope(document) {
  if (!isResearchNode(document))
    return {
      inputs: [],
      outputs: [],
      dependencies: [],
      children: [],
      actors: []
    };
  return {
    inputs: uniqueIds([...(document.data?.input_ids || []), ...(document.data?.target_ids || [])]),
    outputs: researchNodeOutputIds(document),
    dependencies: uniqueIds(document.data?.dependency_ids),
    children: uniqueIds(document.data?.child_ids),
    actors: uniqueIds(document.data?.actor_ids)
  };
}

export function cloneResearchNode(document, { id, at = new Date().toISOString() } = {}) {
  const source = normalizeResearchNode(document);
  const data = source.data;
  return createResearchNode({
    id,
    dataset: source.dataset,
    title: `${source.title || data.objective} copy`,
    objective: data.objective,
    instructions: data.instructions,
    inputIds: data.input_ids,
    targetIds: data.target_ids,
    actorIds: data.actor_ids,
    actorSelectionRules: data.actor_selection_rules,
    dependencyIds: data.dependency_ids,
    limits: data.limits,
    stop: data.stop,
    status: "draft",
    createdAt: at
  });
}
