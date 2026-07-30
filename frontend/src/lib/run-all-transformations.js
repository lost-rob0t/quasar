import { normalizeActorManifest } from "./actors";

export const TRANSFORMATION_RUN_EXTENSION = "quasar.transformations";

function actorRecords(document) {
  const extension = document?.extensions?.["quasar.actor"];
  if (!extension) return [];
  if (Array.isArray(extension)) {
    return extension.filter((record) => record && typeof record === "object");
  }
  return typeof extension === "object" ? [extension] : [];
}

function transformationActors(document) {
  const extension = document?.extensions?.[TRANSFORMATION_RUN_EXTENSION];
  return extension?.actors && typeof extension.actors === "object" ? extension.actors : {};
}

function relationEndpoints(document) {
  if (document?.dtype !== "relation") return [];
  const data = document.data || {};
  return [data.subject || data.source, data.object || data.target].filter(Boolean);
}

export function linkedDocumentIds(documents) {
  const linked = new Set();
  for (const document of documents || []) {
    relationEndpoints(document).forEach((id) => linked.add(id));
  }
  return linked;
}

export function actorTouchedDocumentIds(documents, actorId) {
  const touched = new Set();
  for (const document of documents || []) {
    if (transformationActors(document)[actorId] && document?._id) {
      touched.add(document._id);
    }
    for (const record of actorRecords(document)) {
      if (record.actor_id !== actorId) continue;
      if (document?._id) touched.add(document._id);
      for (const id of record.input_ids || []) {
        if (id) touched.add(id);
      }
    }
  }
  return touched;
}

export function recordTransformationRun(
  document,
  actorId,
  runId,
  timestamp = new Date().toISOString()
) {
  const actors = transformationActors(document);
  return {
    ...document,
    version: Number(document.version || 0) + 1,
    date_updated: timestamp,
    extensions: {
      ...(document.extensions || {}),
      [TRANSFORMATION_RUN_EXTENSION]: {
        version: 1,
        actors: {
          ...actors,
          [actorId]: {
            run_id: String(runId || ""),
            last_run_at: timestamp
          }
        }
      }
    }
  };
}

export function transformationCandidates(
  actorManifest,
  scopeDocuments,
  corpusDocuments = scopeDocuments
) {
  const actor = normalizeActorManifest(actorManifest);
  const accepted = new Set(actor.accepts);
  const linked = linkedDocumentIds(corpusDocuments);
  const touched = actorTouchedDocumentIds(corpusDocuments, actor.id);
  const seen = new Set();

  return (scopeDocuments || []).filter((document) => {
    if (!document?._id || document.dtype === "relation" || seen.has(document._id)) {
      return false;
    }
    seen.add(document._id);
    if (!accepted.has("*") && !accepted.has(document.dtype)) return false;
    return !linked.has(document._id) || !touched.has(document._id);
  });
}

export function transformationBatches(actorManifest, candidates) {
  const actor = normalizeActorManifest(actorManifest);
  const documents = Array.isArray(candidates) ? candidates : [];
  if (actor.maxSelection === 0) return actor.minSelection === 0 ? [[]] : [];
  const batches = [];

  for (let index = 0; index < documents.length; index += actor.maxSelection) {
    const batch = documents.slice(index, index + actor.maxSelection);
    if (batch.length >= actor.minSelection) batches.push(batch);
  }

  return batches;
}

export function mergeTransformationDocuments(currentDocuments, nextDocuments, removedIds = []) {
  const removed = new Set(removedIds || []);
  const merged = new Map(
    (currentDocuments || [])
      .filter((document) => !removed.has(document?._id))
      .map((document) => [document._id, document])
  );
  for (const document of nextDocuments || []) {
    if (document?._id && !removed.has(document._id)) {
      merged.set(document._id, document);
    }
  }
  return [...merged.values()];
}
