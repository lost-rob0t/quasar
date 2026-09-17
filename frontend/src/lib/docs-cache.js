import PouchDB from "pouchdb-browser";

const db = new PouchDB("quasar-docs-cache-v1");
const PREFIX = "doc-source:";

function cacheId(documentId) {
  return `${PREFIX}${encodeURIComponent(String(documentId || ""))}`;
}

export async function cachedDocumentationSource(documentId) {
  try {
    const document = await db.get(cacheId(documentId));
    return typeof document.source === "string" ? document.source : null;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

export async function cacheDocumentationSource(document, source) {
  const _id = cacheId(document.id);
  let existing = null;
  try {
    existing = await db.get(_id);
  } catch (error) {
    if (error?.status !== 404) throw error;
  }

  const next = {
    ...(existing || { _id }),
    type: "documentation-source",
    documentId: document.id,
    revision: document.revision || null,
    asset: document.asset,
    remote: Boolean(document.remote),
    source: String(source),
    cachedAt: new Date().toISOString()
  };
  await db.put(next);
  return next;
}

export async function loadDocumentationSource(document, { preferCache = false } = {}) {
  if (!document?.id || !document?.asset) throw new Error("Documentation entry is incomplete");

  if (preferCache || !navigator.onLine) {
    const cached = await cachedDocumentationSource(document.id);
    if (cached != null) return { source: cached, cached: true };
  }

  try {
    const response = await fetch(document.asset, { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error(`Documentation source returned ${response.status}`);
    const source = await response.text();
    await cacheDocumentationSource(document, source);
    return { source, cached: false };
  } catch (error) {
    const cached = await cachedDocumentationSource(document.id);
    if (cached != null) return { source: cached, cached: true };
    throw error;
  }
}

export async function cacheDocumentationSet(documents, onProgress = () => {}) {
  const items = Array.isArray(documents) ? documents : [];
  let completed = 0;
  const failures = [];

  for (const document of items) {
    try {
      await loadDocumentationSource(document, { preferCache: false });
    } catch (error) {
      failures.push({ id: document.id, message: error?.message || String(error) });
    }
    completed += 1;
    onProgress({ completed, total: items.length, failures: failures.length });
  }

  return { completed, total: items.length, failures };
}

export async function documentationCacheStats() {
  const response = await db.allDocs({ startkey: PREFIX, endkey: `${PREFIX}\ufff0` });
  return { cached: response.rows.length };
}
