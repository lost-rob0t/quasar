// Bounded route query cache for document.search paging.
//
// One page per request, cursors chained from page 1, byte/record budgets
// enforced by trimming the highest cached pages (the chain stays contiguous
// from page 1), LRU across queries, and restart instead of revision mixing
// on stale or mismatched cursors, per docs/BOUNDED-WORKBENCH.md:
// never drain continuation pages into a corpus array, and never treat a
// full page as the end of the scope.

export const SEARCH_PAGE_DEFAULT = 50;
export const SEARCH_PAGE_MAX = 250;

const RESTARTABLE_CURSOR_CODES = new Set(["query.stale-cursor", "query.invalid-cursor"]);

export function normalizeSearchQuery({ q = "", dtype = "", dataset = "", perPage } = {}) {
  const text = String(q || "").trim();
  const type = String(dtype || "").trim();
  const datasetName = String(dataset || "").trim();
  const limit = Math.min(Math.max(Number(perPage) || SEARCH_PAGE_DEFAULT, 1), SEARCH_PAGE_MAX);
  const filters = {};
  if (text) filters.q = text;
  if (type) filters.dtype = type;
  if (datasetName) filters.datasets = [datasetName];
  return { filters, limit };
}

export function searchQueryKey(query) {
  const entries = Object.entries(query.filters).map(([name, value]) => [
    name,
    Array.isArray(value) ? [...value].sort() : value
  ]);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify({ filters: entries, limit: query.limit });
}

function estimateBytes(value) {
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return 0;
  }
}

class SearchQueryEntry {
  constructor(key, query) {
    this.key = key;
    this.query = query;
    this.pages = new Map();
    this.records = 0;
    this.bytes = 0;
    this.complete = false;
  }

  page(number) {
    return this.pages.get(number) || null;
  }

  highestPage() {
    return this.pages.size;
  }

  store(pageRecord) {
    this.pages.set(pageRecord.pageNumber, pageRecord);
    this.records += pageRecord.rows.length;
    this.bytes += pageRecord.bytes;
    if (pageRecord.complete) this.complete = true;
  }

  reset() {
    this.pages.clear();
    this.records = 0;
    this.bytes = 0;
    this.complete = false;
  }

  // Trim from the highest pages so the chain stays contiguous from page 1.
  trim(maxRecords, maxBytes) {
    while (this.pages.size > 1 && (this.records > maxRecords || this.bytes > maxBytes)) {
      const trimmed = this.pages.get(this.pages.size);
      this.pages.delete(this.pages.size);
      this.records -= trimmed.rows.length;
      this.bytes -= trimmed.bytes;
    }
  }
}

export function createRouteQueryCache({
  maxQueries = 6,
  maxRecordsPerQuery = 2500,
  maxBytesPerQuery = 512 * 1024
} = {}) {
  const entries = new Map();

  function entryFor(query) {
    const key = searchQueryKey(query);
    const existing = entries.get(key);
    if (existing) {
      entries.delete(key);
      entries.set(key, existing);
      return existing;
    }
    const entry = new SearchQueryEntry(key, query);
    entries.set(key, entry);
    while (entries.size > maxQueries) entries.delete(entries.keys().next().value);
    return entry;
  }

  async function fetchPage(client, entry, cursor) {
    const request = {
      ...entry.query.filters,
      limit: entry.query.limit,
      ...(cursor ? { cursor } : {})
    };
    const response = await client.documentSearch(request);
    const rows = Array.isArray(response?.documents) ? response.documents : [];
    return {
      pageNumber: entry.pages.size + 1,
      rows,
      cursor: response?.cursor || null,
      complete: Boolean(response?.complete),
      performance: response?.performance || null,
      bytes: estimateBytes(rows)
    };
  }

  // pageNumber is expected to be at most one beyond the cached chain (the
  // documents route clamps deep links), so each call fetches at most the
  // missing tail instead of draining continuations toward a far page.
  async function getPage(client, query, pageNumber) {
    const target = Number(pageNumber);
    if (!Number.isInteger(target) || target < 1) {
      throw new RangeError("Page numbers start at 1.");
    }
    const entry = entryFor(query);
    const cached = entry.page(target);
    if (cached) return cached;

    let restarted = false;
    let served = null;
    while (!served) {
      const highest = entry.highestPage();
      if (highest && entry.page(highest).complete) break;
      const cursor = highest ? entry.page(highest).cursor : null;
      let pageRecord;
      try {
        pageRecord = await fetchPage(client, entry, cursor);
      } catch (error) {
        if (!RESTARTABLE_CURSOR_CODES.has(error?.code) || restarted || entry.highestPage() === 0) {
          throw error;
        }
        restarted = true;
        entry.reset();
        continue;
      }
      entry.store(pageRecord);
      served = pageRecord.pageNumber === target ? pageRecord : null;
    }
    entry.trim(maxRecordsPerQuery, maxBytesPerQuery);
    // The served page survives budget trimming as a return value even when
    // the cache could not keep it; callers hold the record they asked for.
    return served || entry.page(target);
  }

  async function getDocuments(client, query, pageNumber) {
    const entry = entries.get(searchQueryKey(query));
    const page = entry?.page(pageNumber);
    if (!page) return null;
    if (page.documents) return page;

    const ids = page.rows.map((row) => row?.id).filter(Boolean);
    if (!ids.length) {
      page.documents = [];
      page.missingIds = [];
      return page;
    }

    const response = await client.documentBatch(ids);
    const canonical = Array.isArray(response?.documents) ? response.documents : [];
    const order = new Map(ids.map((id, index) => [id, index]));
    page.documents = canonical
      .filter((document) => order.has(document?.id))
      .sort((left, right) => order.get(left.id) - order.get(right.id));
    page.missingIds = Array.isArray(response?.missingIds) ? response.missingIds : [];
    page.bytes += estimateBytes(page.documents);
    entry.trim(maxRecordsPerQuery, maxBytesPerQuery);
    return page;
  }

  function peekDocuments(query, pageNumber) {
    return entries.get(searchQueryKey(query))?.page(pageNumber) || null;
  }

  function totals(query) {
    const entry = entries.get(searchQueryKey(query));
    if (!entry) return { known: 0, complete: false, pages: 0 };
    return { known: entry.records, complete: entry.complete, pages: entry.pages.size };
  }

  function invalidate() {
    entries.clear();
  }

  return { getPage, getDocuments, peekDocuments, totals, invalidate };
}
