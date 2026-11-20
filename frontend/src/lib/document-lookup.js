import { useEffect, useState } from "react";
import { toLegacyUiDocument } from "./canonical-document";

// Bounded direct lookups for document-centric routes. Editors, detail views,
// and related consumers fetch exactly the canonical records they render via
// document.batch instead of scanning the startup corpus, per
// docs/BOUNDED-WORKBENCH.md. The id-keyed cache is a small LRU so back
// navigation stays instant without retaining the workspace.

const MAX_ENTRIES = 200;
const cache = new Map();

export function peekLookupDocument(id) {
  return cache.get(String(id)) || null;
}

export function resetDocumentLookup() {
  cache.clear();
}

function remember(id, document) {
  cache.set(String(id), document);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

// Resolves the canonical document for id, or null when the store reports it
// missing. Canonical form: callers decide how to present it.
export async function lookupDocument(client, id) {
  const key = String(id || "");
  if (!key) return null;
  const hit = peekLookupDocument(key);
  if (hit) return hit;
  if (!client?.documentBatch) throw new Error("Control plane is unavailable.");
  const response = await client.documentBatch([key]);
  const canonical = (Array.isArray(response?.documents) ? response.documents : []).find(
    (document) => (document?.id || document?._id) === key
  );
  if (!canonical) return null;
  remember(key, canonical);
  return canonical;
}

// Corpus documents are already legacy UI shaped; canonical lookups convert on
// the way out so callers can treat both uniformly.
export function presentDocument(document) {
  if (!document) return null;
  return document._id ? document : toLegacyUiDocument(document);
}

export function useDocumentLookup(client, id, { skip = false } = {}) {
  const key = String(id || "");
  const [state, setState] = useState(() => ({
    document: peekLookupDocument(key),
    loading: false,
    error: null
  }));

  useEffect(() => {
    if (skip || !key) return;
    const hit = peekLookupDocument(key);
    if (hit) {
      setState({ document: hit, loading: false, error: null });
      return;
    }
    let active = true;
    setState({ document: null, loading: true, error: null });
    lookupDocument(client, key)
      .then((document) => {
        if (active) setState({ document, loading: false, error: null });
      })
      .catch((cause) => {
        if (active) {
          setState({
            document: null,
            loading: false,
            error: cause?.message || "Document lookup failed."
          });
        }
      });
    return () => {
      active = false;
    };
  }, [client, key, skip]);

  return state;
}
