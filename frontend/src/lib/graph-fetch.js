// Bounded document-graph fetch: one-hop neighbors or a breadth-first walk,
// from the local workspace or the star-server (via the control-plane relay).
// Every walk is budget- and depth-capped; nothing drains continuations.

import { toCanonicalDocument } from "./canonical-document";
import { assertDocument, createDocument } from "starintel_doc/legacy";

export const GRAPH_WALK_MAX_DEPTH = 3;
export const GRAPH_WALK_DEFAULT_BUDGET = 200;
const MAX_PAGES_PER_NODE = 5;

function isRelationEndpoint(document, id) {
  return document?.data?.subject === id || document?.data?.object === id;
}

export function localNeighborIds(documents, id) {
  const neighbors = new Set();
  for (const document of documents) {
    if (document.dtype !== "relation") continue;
    const { subject, object } = document.data || {};
    if (subject === id && object) neighbors.add(object);
    if (object === id && subject) neighbors.add(subject);
  }
  neighbors.delete(id);
  return [...neighbors];
}

function relationsBetween(documents, leftId, rightId) {
  return documents.filter(
    (document) =>
      document.dtype === "relation" &&
      ((document.data?.subject === leftId && document.data?.object === rightId) ||
        (document.data?.subject === rightId && document.data?.object === leftId))
  );
}

/**
 * Breadth-first walk over the LOCAL workspace graph.
 * Returns { documents, relations, visited, truncated } - no async, nothing remote.
 */
export function walkLocalGraph(
  documents,
  rootId,
  { depth = 2, budget = GRAPH_WALK_DEFAULT_BUDGET } = {}
) {
  const byId = new Map(documents.map((document) => [document._id, document]));
  const root = byId.get(rootId);
  if (!root) return { documents: [], relations: [], visited: [], truncated: false };
  const visited = new Set([rootId]);
  const collectedDocs = [root];
  const collectedRelations = new Map();
  let frontier = [rootId];
  let truncated = false;
  for (let level = 0; level < depth && frontier.length; level++) {
    const next = [];
    for (const current of frontier) {
      for (const neighborId of localNeighborIds(documents, current)) {
        for (const relation of relationsBetween(documents, current, neighborId)) {
          collectedRelations.set(relation._id, relation);
        }
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        const neighbor = byId.get(neighborId);
        if (!neighbor) continue;
        if (collectedDocs.length >= budget) {
          truncated = true;
          continue;
        }
        collectedDocs.push(neighbor);
        next.push(neighborId);
      }
      if (collectedDocs.length >= budget) truncated = true;
    }
    frontier = next;
  }
  return {
    documents: collectedDocs,
    relations: [...collectedRelations.values()],
    visited: [...visited],
    truncated
  };
}

/**
 * Breadth-first walk over the SERVER graph via the control-plane relay
 * (starintel.neighbors + starintel.document). Pages each node's relations
 * with the cursor, then fetches each new neighbor's document, until the
 * depth/budget caps are hit. Bounded: per-node page cap plus the global
 * document budget.
 */
export async function walkRemoteGraph(
  cpClient,
  config,
  rootId,
  { depth = 2, budget = GRAPH_WALK_DEFAULT_BUDGET, limit = 100 } = {}
) {
  if (!cpClient?.starintelNeighbors) {
    throw new Error("Control plane does not expose starintel.neighbors.");
  }
  const documents = new Map();
  const relations = [];
  const relationIds = new Set();
  const seen = new Set([rootId]);
  let truncated = false;
  let requests = 0;
  let frontier = [rootId];

  const pageNeighbors = async (id) => {
    let bookmark;
    const collected = [];
    for (let page = 0; page < MAX_PAGES_PER_NODE; page++) {
      const response = await cpClient.starintelNeighbors({
        ...config,
        id,
        limit,
        ...(bookmark ? { bookmark } : {})
      });
      requests += 1;
      if (response?.document && !documents.has(id)) documents.set(id, response.document);
      for (const relation of response?.relations || []) {
        if (!relation?.id || relationIds.has(relation.id)) continue;
        relationIds.add(relation.id);
        relations.push(relation);
        collected.push(relation);
      }
      bookmark = response?.bookmark || null;
      if (!bookmark) break;
    }
    return collected;
  };

  for (let level = 0; level < depth && frontier.length; level++) {
    const next = [];
    for (const id of frontier) {
      if (documents.size >= budget) {
        truncated = true;
        break;
      }
      const nodeRelations = await pageNeighbors(id);
      for (const relation of nodeRelations) {
        const neighborId = relation.neighbor;
        if (!neighborId || seen.has(neighborId)) continue;
        seen.add(neighborId);
        if (documents.size >= budget) {
          truncated = true;
          continue;
        }
        try {
          const neighborDoc = await cpClient.starintelDocument({ ...config, id: neighborId });
          requests += 1;
          if (neighborDoc && typeof neighborDoc === "object" && neighborDoc._id) {
            documents.set(neighborId, neighborDoc);
            next.push(neighborId);
          }
        } catch {
          // Unreachable neighbor: keep walking the rest of the frontier.
        }
      }
    }
    frontier = next;
  }

  return {
    documents: [...documents.values()],
    relations,
    visited: [...seen],
    truncated,
    requests
  };
}

/**
 * Convert a walk result into importable canonical documents. Server
 * neighbors return compact relation tuples, not relation documents; the
 * synthesized relation docs keep the server's stable ids so repeated
 * fetches stay idempotent.
 */
export function canonicalRemoteGraph(result, rootId, dataset = "default") {
  return {
    documents: result.documents.map((raw) =>
      toCanonicalDocument(raw, { allowLegacy090: true, preserveUnmapped: true })
    ),
    relations: (result.relations || []).map((tuple) => {
      const doc = createDocument("relation", {
        dataset,
        title: tuple.predicate,
        data: {
          subject: tuple.direction === "object" ? tuple.neighbor : rootId,
          predicate: tuple.predicate,
          object: tuple.direction === "object" ? rootId : tuple.neighbor,
          directed: true
        }
      });
      if (tuple.id) doc._id = tuple.id;
      return assertDocument(doc);
    })
  };
}
