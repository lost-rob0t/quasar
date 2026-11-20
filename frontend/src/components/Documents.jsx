import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  ExternalLink,
  HardDriveDownload,
  Network,
  Plus,
  Search,
  Trash2,
  X
} from "lucide-react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { dtypes } from "starintel_doc";
import { documentLabel } from "starintel_doc/legacy";
import { toLegacyUiDocument, toCanonicalDocument } from "../lib/canonical-document";
import { connectedDocumentIds } from "../lib/document-delete";
import { documentsToJsonl, documentsToHistoricalJsonl, downloadText } from "../lib/importer";
import { operation } from "../lib/operations";
import {
  createRouteQueryCache,
  normalizeSearchQuery,
  searchQueryKey
} from "../lib/route-query-cache";
import DatasetsPage from "./DatasetsPage";
import DatasetCombobox from "./DatasetCombobox";
import { presentDocument, useDocumentLookup } from "../lib/document-lookup";
import { useQuasar } from "../store";

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZES = [25, 50, 100, 250];

// Route-scoped bounded query cache: survives navigation to a document and
// back, never drains continuations, and restarts on stale cursors.
export const documentsRouteCache = createRouteQueryCache();

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function parsePageSize(value) {
  const parsed = Number.parseInt(value || "", 10);
  return PAGE_SIZES.includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

function parsePage(value) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function paginationRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  const pages = [1];
  if (current > 4) pages.push("left-ellipsis");

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let page = start; page <= end; page += 1) pages.push(page);

  if (current < total - 3) pages.push("right-ellipsis");
  pages.push(total);
  return pages;
}

// Search projections are display rows, never canonical writes. Present the
// projection when the canonical record is missing rather than hiding the row.
function rowFallbackDocument(row) {
  return {
    _id: row.id,
    dataset: row.dataset,
    dtype: row.dtype,
    schema_version: row.schemaVersion,
    title: row.title || row.name || "",
    summary: row.summary || "",
    date_updated: row.updatedAt ? new Date(row.updatedAt * 1000).toISOString() : null,
    projection: true
  };
}

function mergePageDocuments(rows, canonical) {
  const byId = new Map(canonical.map((document) => [document.id, document]));
  return rows.map((row) => {
    const document = byId.get(row?.id);
    return document ? toLegacyUiDocument(document) : rowFallbackDocument(row);
  });
}

function catalogDatasetNames(datasets) {
  return [
    ...new Set((datasets || []).map((row) => String(row?.name || "").trim()).filter(Boolean))
  ].sort();
}

// Live-ingest rows come back from star-server /search as couchdb FTS rows
// with the full canonical document embedded (include_docs). The embedded
// records keep their historical schema_version (0.9.x), which the strict
// canonical validator rejects — the workspace pipeline converts tek9 rows
// server-side, the relay does not. Convert when the document validates and
// fall back to a searchable projection built from the raw record.
export function liveRowDocument(row) {
  const doc = row?.doc;
  if (doc) {
    try {
      return toLegacyUiDocument(doc);
    } catch {
      // Fall through to the projection below.
    }
  }
  const fields = row?.fields || {};
  const data = doc?.data || {};
  return {
    _id: doc?._id || doc?.id || row?.id,
    dtype: doc?.dtype || fields.dtype || "",
    dataset: doc?.dataset || fields.dataset || "",
    title: data.title || data.name || doc?.title || fields.title || "",
    summary: data.summary || doc?.summary || fields.summary || "",
    date_updated: doc?.date_updated || fields.date_updated || null,
    data,
    sources: doc?.sources || [],
    evidence: doc?.evidence || [],
    projection: true
  };
}

export function DocumentsPage() {
  const {
    documents,
    execute,
    executeBatch,
    setNotice,
    createGraph,
    addDocumentsToActiveGraph,
    cpClient,
    settings
  } = useQuasar();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") || "";
  const dtype = params.get("dtype") || "";
  const dataset = params.get("dataset") || "";
  const group = params.get("group") || "";
  const serverUrl = settings?.serverUrl || "";
  const serverToken = settings?.serverToken || "";
  const requestedPage = parsePage(params.get("page"));
  const pageSize = parsePageSize(params.get("perPage"));
  const hasSearchScope = Boolean(query || dtype || dataset);

  const searchQuery = useMemo(
    () => normalizeSearchQuery({ q: query, dtype, dataset, perPage: pageSize }),
    [query, dtype, dataset, pageSize]
  );
  const searchKey = useMemo(() => searchQueryKey(searchQuery), [searchQuery]);

  // Render the cached page instantly; the effect below refreshes it.
  const [pageState, setPageState] = useState(() => {
    const cached = documentsRouteCache.peekDocuments(searchQuery, requestedPage);
    return cached
      ? {
          pageNumber: cached.pageNumber,
          rows: cached.rows,
          documents: mergePageDocuments(cached.rows, cached.documents || []),
          complete: cached.complete
        }
      : null;
  });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [datasetNames, setDatasetNames] = useState(null);
  const requestToken = useRef(0);

  // Transitional freshness: the startup snapshot drain still publishes corpus
  // changes. Search cursors bind the workspace revision, so cached pages are
  // dropped instead of restarted against mixed revisions.
  const corpusVersion = documents.length;
  const corpusVersionRef = useRef(corpusVersion);
  useEffect(() => {
    if (corpusVersionRef.current === corpusVersion) return;
    corpusVersionRef.current = corpusVersion;
    documentsRouteCache.invalidate();
    setPageState(null);
  }, [corpusVersion]);

  // Server results (forgejo #142) share the table with the workspace rows:
  // one merged list, local first, server-only matches appended with a chip.
  // The first server page follows the query automatically; further pages are
  // explicit (one bounded bookmark request per click, never a drain).
  const liveChain = useRef({
    key: null,
    pages: {},
    bookmarks: {},
    cursors: {},
    total: null,
    complete: false
  });
  const [liveSnapshot, setLiveSnapshot] = useState(null);
  const [liveError, setLiveError] = useState(null);
  const [liveView, setLiveView] = useState(null);
  const [savedIds, setSavedIds] = useState(() => new Set());
  const [savingIds, setSavingIds] = useState(() => new Set());
  const liveRequestToken = useRef(0);

  const resetLiveChain = () => {
    liveChain.current = {
      key: searchKey,
      pages: {},
      bookmarks: {},
      cursors: {},
      total: null,
      complete: false
    };
    setLiveSnapshot(null);
  };

  useEffect(() => {
    let active = true;
    const token = ++requestToken.current;
    (async () => {
      setLoading(true);
      try {
        // Deep links never drain toward a far page: fetch at most one page
        // beyond the cached chain and clamp the route to it.
        const totals = documentsRouteCache.totals(searchQuery);
        const target = Math.min(requestedPage, totals.pages + 1);
        if (target !== requestedPage) {
          const next = new URLSearchParams(params);
          if (target <= 1) next.delete("page");
          else next.set("page", String(target));
          setParams(next, { replace: true });
        }

        const page = await documentsRouteCache.getPage(cpClient, searchQuery, target);
        let canonical = [];
        if (page) {
          try {
            const withDocuments = await documentsRouteCache.getDocuments(
              cpClient,
              searchQuery,
              page.pageNumber
            );
            canonical = withDocuments?.documents || [];
          } catch {
            canonical = []; // Canonical lookup failed; show search projections.
          }
        }
        if (!active || token !== requestToken.current) return;

        if (page) {
          setPageState({
            pageNumber: page.pageNumber,
            rows: page.rows,
            documents: mergePageDocuments(page.rows, canonical),
            complete: page.complete
          });
          setError(null);
        } else {
          setPageState({ pageNumber: target, rows: [], documents: [], complete: true });
          setError(null);
        }
      } catch (cause) {
        if (active && token === requestToken.current) {
          setError(cause?.message || "Document search is unavailable.");
        }
      } finally {
        if (active && token === requestToken.current) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpClient, searchKey, requestedPage, corpusVersion]);

  // Server matches for the current query. One bounded page follows the query
  // automatically; each further page is an explicit user click. With no
  // query the same chain serves the recents projection (newest-first
  // listing via /documents/recent), so remote ingest is visible while
  // browsing without a search term.
  useEffect(() => {
    if (!cpClient?.starintelSearch) return;
    if (!serverUrl) {
      setLiveError(null);
      resetLiveChain();
      return;
    }
    let active = true;
    const token = ++liveRequestToken.current;
    (async () => {
      setLiveError(null);
      try {
        const chain = liveChain.current;
        if (chain.key !== searchKey) resetLiveChain();
        const highest = Math.max(0, ...Object.keys(chain.pages).map(Number));
        if (highest === 0) {
          if (query) {
            const response = await cpClient.starintelSearch({
              url: serverUrl,
              token: serverToken || undefined,
              q: query,
              limit: Math.min(pageSize, 25)
            });
            const rows = (response?.rows || []).map((row) => ({
              id: row?.id,
              document: liveRowDocument(row),
              raw: row?.doc || null
            }));
            chain.pages[1] = rows;
            chain.total =
              typeof response?.total_rows === "number" ? response.total_rows : chain.total;
            chain.bookmarks[1] = response?.bookmark && rows.length ? response.bookmark : null;
          } else {
            const response = await cpClient.starintelApi("documents-recent", {
              url: serverUrl,
              token: serverToken || undefined,
              limit: Math.min(pageSize, 25),
              ...(dataset ? { dataset } : {})
            });
            const rows = (response?.rows || []).map((row) => ({
              id: row?.id,
              document: liveRowDocument(row),
              raw: row?.doc || null
            }));
            chain.pages[1] = rows;
            // total_rows on recents pages is the authorized page length, not
            // the scope size - never surface it as a workspace-style count.
            chain.cursors[1] =
              response?.next_start_key && rows.length
                ? {
                    start_key: response.next_start_key,
                    start_key_doc_id: response.next_start_key_doc_id || null
                  }
                : null;
          }
        }
        const fetched = Math.max(0, ...Object.keys(chain.pages).map(Number));
        chain.complete =
          fetched > 0 && !chain.bookmarks[fetched] && !chain.cursors[fetched];
        if (!active || token !== liveRequestToken.current) return;
        setLiveSnapshot({
          pages: { ...chain.pages },
          total: chain.total,
          complete: chain.complete
        });
      } catch (cause) {
        if (active && token === liveRequestToken.current) {
          setLiveError(cause?.message || "Server search failed.");
        }
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpClient, searchKey, query, dataset, pageSize, serverUrl, serverToken, corpusVersion]);

  async function loadMoreServerResults() {
    if (!cpClient?.starintelSearch || !serverUrl) return;
    const chain = liveChain.current;
    if (chain.key !== searchKey) return;
    const highest = Math.max(0, ...Object.keys(chain.pages).map(Number));
    const bookmark = chain.bookmarks[highest];
    const cursor = chain.cursors[highest];
    if (!bookmark && !cursor) return;
    const token = ++liveRequestToken.current;
    setLoading(true);
    setLiveError(null);
    try {
      const next = highest + 1;
      let rows = [];
      if (query) {
        const response = await cpClient.starintelSearch({
          url: serverUrl,
          token: serverToken || undefined,
          q: query,
          limit: Math.min(pageSize, 25),
          ...(bookmark ? { bookmark } : {})
        });
        rows = (response?.rows || []).map((row) => ({
          id: row?.id,
          document: liveRowDocument(row),
          raw: row?.doc || null
        }));
        chain.total =
          typeof response?.total_rows === "number" ? response.total_rows : chain.total;
        chain.bookmarks[next] = response?.bookmark && rows.length ? response.bookmark : null;
      } else {
        const response = await cpClient.starintelApi("documents-recent", {
          url: serverUrl,
          token: serverToken || undefined,
          limit: Math.min(pageSize, 25),
          ...(dataset ? { dataset } : {}),
          ...(cursor?.start_key ? { start_key: cursor.start_key } : {}),
          ...(cursor?.start_key_doc_id
            ? { start_key_doc_id: cursor.start_key_doc_id }
            : {})
        });
        rows = (response?.rows || []).map((row) => ({
          id: row?.id,
          document: liveRowDocument(row),
          raw: row?.doc || null
        }));
        chain.cursors[next] =
          response?.next_start_key && rows.length
            ? {
                start_key: response.next_start_key,
                start_key_doc_id: response.next_start_key_doc_id || null
              }
            : null;
      }
      chain.pages[next] = rows;
      const fetched = Math.max(0, ...Object.keys(chain.pages).map(Number));
      chain.complete =
        fetched > 0 && !chain.bookmarks[fetched] && !chain.cursors[fetched];
      setLiveSnapshot({
        pages: { ...chain.pages },
        total: chain.total,
        complete: chain.complete
      });
    } catch (cause) {
      if (token === liveRequestToken.current) {
        setLiveError(cause?.message || "Server search failed.");
      }
    } finally {
      if (token === liveRequestToken.current) setLoading(false);
    }
  }

  // Mirror a server record into the workspace: migrate the historical 0.9.x
  // record to the canonical wire, then commit it like any import. The corpus
  // event refresh swaps the live-only row for the local one.
  async function saveLiveDocument(row) {
    if (!row?.raw) {
      setNotice({ kind: "error", message: "This server record has no embedded document to save." });
      return;
    }
    setSavingIds((current) => new Set(current).add(row.id));
    try {
      const canonical = toCanonicalDocument(row.raw, {
        allowLegacy090: true,
        preserveUnmapped: true
      });
      await executeBatch([canonical], "Save server document", { replace: true });
      setSavedIds((current) => new Set(current).add(row.id));
      setNotice({ kind: "success", message: `Saved ${row.id} to the workspace.` });
    } catch (cause) {
      setNotice({
        kind: "error",
        message: cause?.message || `Could not save ${row.id} locally.`
      });
    } finally {
      setSavingIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
    }
  }

  async function addLiveDocumentToGraph(row) {
    try {
      if (row?.raw && !savedIds.has(row.id)) {
        const canonical = toCanonicalDocument(row.raw, {
          allowLegacy090: true,
          preserveUnmapped: true
        });
        await executeBatch([canonical], "Save server document", { replace: true });
        setSavedIds((current) => new Set(current).add(row.id));
      }
      createGraph(`Search: ${query || "server documents"}`);
      addDocumentsToActiveGraph([row.id]);
      navigate("/graph?review=all", {
        state: { importedIds: [row.id], revealUnreviewed: true, source: "documents-page" }
      });
    } catch (cause) {
      setNotice({ kind: "error", message: cause?.message || "Could not add to graph." });
    }
  }

  function openLiveDocument(row) {
    if (!row) return;
    setLiveView({ id: row.id, document: row.raw });
  }

  useEffect(() => {
    if (!cpClient?.workspaceBootstrap) return;
    let active = true;
    cpClient
      .workspaceBootstrap()
      .then((bootstrap) => {
        if (active) setDatasetNames(catalogDatasetNames(bootstrap?.datasets));
      })
      .catch(() => {
        if (active) setDatasetNames([]);
      });
    return () => {
      active = false;
    };
  }, [cpClient, corpusVersion]);

  const datasetOptions = useMemo(() => {
    if (datasetNames === null) return [];
    return dataset && !datasetNames.includes(dataset)
      ? [...datasetNames, dataset].sort()
      : datasetNames;
  }, [datasetNames, dataset]);

  // Merged view: the workspace page renders first; server-only matches
  // (deduped against the whole local corpus and just-saved rows) append
  // below with a divider. `complete` reports scope exhaustion, never page
  // fullness; totals count cached rows only, so an incomplete scope renders
  // as "N+".
  const totals = documentsRouteCache.totals(searchQuery);
  const contiguousPages = totals.pages;
  const reachablePages = totals.complete ? contiguousPages : contiguousPages + 1;
  const page = Math.min(requestedPage, Math.max(reachablePages, 1));
  const pageDocuments = pageState?.documents || [];
  const corpusIds = useMemo(
    () => new Set(documents.map((document) => document._id)),
    [documents]
  );
  const livePages = liveSnapshot?.pages || {};
  const liveRows = Object.keys(livePages)
    .map(Number)
    .sort((left, right) => left - right)
    .flatMap((pageNumber) => livePages[pageNumber] || []);
  // forgejo #143 fallback: the server FTS has no dtype/dataset params yet,
  // so the URL filters are enforced here on server rows until the server
  // learns faceted filters. Workspace rows are filtered server-side by the
  // route query; server rows are post-filtered client-side.
  const liveOnlyRows = liveRows.filter((row) => {
    if (!row.id || corpusIds.has(row.id) || savedIds.has(row.id)) return false;
    const document = row.document || {};
    if (dtype && document.dtype !== dtype) return false;
    if (dataset && document.dataset !== dataset) return false;
    return true;
  });
  const liveHighest = Math.max(0, ...Object.keys(livePages).map(Number));
  const liveTotal = typeof liveSnapshot?.total === "number" ? liveSnapshot.total : null;
  const pageStart = pageDocuments.length ? (page - 1) * pageSize + 1 : 0;
  const pageEnd = pageDocuments.length ? pageStart + pageDocuments.length - 1 : 0;
  const pages = useMemo(
    () => paginationRange(page, Math.max(reachablePages, 1)),
    [page, reachablePages]
  );
  const resultCount = totals.complete
    ? totals.known.toLocaleString()
    : `${totals.known.toLocaleString()}+`;

  const set = (key, value, { resetPage = true, replace = false } = {}) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (resetPage) next.delete("page");
    setParams(next, { replace });
  };

  function setPage(nextPage) {
    const next = new URLSearchParams(params);
    if (nextPage <= 1) next.delete("page");
    else next.set("page", String(nextPage));
    setParams(next);
  }

  function setPageSize(nextSize) {
    const next = new URLSearchParams(params);
    if (nextSize === DEFAULT_PAGE_SIZE) next.delete("perPage");
    else next.set("perPage", String(nextSize));
    next.delete("page");
    setParams(next);
  }

  function clearFilters() {
    const next = new URLSearchParams(params);
    next.delete("q");
    next.delete("dtype");
    next.delete("dataset");
    next.delete("page");
    setParams(next);
  }

  // Bounded reads cannot import an entire search scope without draining
  // continuations, so the graph import is scoped to the visible page.
  function importPageToGraph() {
    if (!pageDocuments.length) return;
    try {
      const scope = query || dataset || dtype || "documents";
      createGraph(`Search: ${scope}`);
      const importedIds = pageDocuments.map((document) => document._id);
      addDocumentsToActiveGraph(importedIds);
      navigate("/graph?review=all", {
        state: {
          importedIds,
          revealUnreviewed: true,
          source: "documents-page"
        }
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function removeDocument(document) {
    const deleteIds = connectedDocumentIds(documents, [document._id]);
    if (
      !window.confirm(
        `Delete ${document._id} and ${deleteIds.length - 1} connected relation document(s)?`
      )
    )
      return;
    try {
      await execute(
        operation.batch(
          deleteIds.map((item) => operation.remove(item)),
          "Delete corpus documents"
        ),
        `Delete ${deleteIds.length} corpus document(s)`
      );
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  function addLocalDocumentToGraph(document) {
    try {
      const scope = query || dataset || dtype || "documents";
      createGraph(`Search: ${scope}`);
      addDocumentsToActiveGraph([document._id]);
      navigate("/graph?review=all", {
        state: { importedIds: [document._id], revealUnreviewed: true, source: "documents-page" }
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  function openLiveDocument(row) {
    if (!row) return;
    setLiveView({ id: row.id, document: row.raw });
  }

  if (group === "dataset") {
    return <DatasetsPage />;
  }

  return (
    <section className="documents-workspace">
      <div className="page-heading documents-heading">
        <div>
          <span className="eyebrow">Corpus</span>
          <h1>Documents</h1>
          <p>
            One searchable view of the workspace corpus and the live server ingest.
          </p>
        </div>
        <div className="button-row">
          <button
            className="button"
            onClick={importPageToGraph}
            disabled={!pageDocuments.length}
            title="Create a graph from the documents on this page (bounded read; full search imports arrive with bounded mutations)"
          >
            <Network size={16} /> Add page to graph
          </button>
          <button
            className="button"
            disabled={!pageDocuments.length}
            onClick={() => {
              try {
                downloadText("starintel-documents.jsonl", documentsToJsonl(pageDocuments));
              } catch (error) {
                setNotice({
                  kind: "error",
                  message: `Canonical export blocked: ${error.message}. Use historical archive export to preserve unsupported records.`
                });
              }
            }}
            title="Export the documents on this page in canonical form"
          >
            <Download size={16} /> Export page
          </button>
          <button
            type="button"
            className="button"
            disabled={!pageDocuments.length}
            onClick={() =>
              downloadText(
                "starintel-historical-archive.jsonl",
                documentsToHistoricalJsonl(pageDocuments)
              )
            }
            title="Export the documents on this page as a historical archive"
          >
            Export page archive
          </button>
          <Link className="button primary" to="/documents/new">
            <Plus size={16} /> Add document
          </Link>
        </div>
      </div>

      <div className="document-search-panel">
        <div className="document-search-primary">
          <div className="document-search-field">
            <Search size={19} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => set("q", event.target.value, { replace: true })}
              aria-label="Search documents"
              placeholder="Search names, titles, summaries, and other top-level fields…"
              autoComplete="off"
            />
            {query && (
              <button
                className="document-search-clear"
                type="button"
                onClick={() => set("q", "", { replace: true })}
                title="Clear search"
                aria-label="Clear document search"
              >
                <X size={16} />
              </button>
            )}
          </div>
          <div className="document-result-summary" aria-live="polite">
            <strong>{loading && !pageState ? "…" : resultCount}</strong>
            <span>in workspace</span>
            {serverUrl && query && (
              <>
                <span className="summary-divider" aria-hidden="true">·</span>
                <strong>
                  {liveTotal === null ? "…" : liveTotal.toLocaleString()}
                </strong>
                <span>on server</span>
              </>
            )}
          </div>
        </div>

        <div className="document-filter-row">
          <label className="document-filter-control">
            <span>Type</span>
            <select value={dtype} onChange={(event) => set("dtype", event.target.value)}>
              <option value="">All dtypes</option>
              {dtypes.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <DatasetCombobox
            value={dataset}
            options={datasetOptions}
            onChange={(next) => set("dataset", next)}
            placeholder="All datasets"
          />
          {hasSearchScope && (
            <button
              className="button small document-clear-filters"
              type="button"
              onClick={clearFilters}
            >
              <X size={14} /> Clear filters
            </button>
          )}
          {serverUrl && query && (
            <span className="muted document-live-hint">
              Server matches below the workspace rows. Type and dataset filters are applied
              client-side until the server supports faceted filters (forgejo #143).
            </span>
          )}
        </div>
      </div>

      <div className="document-list-meta">
        <span>
          {pageDocuments.length
            ? totals.complete
              ? `Workspace ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${totals.known.toLocaleString()}`
              : `Workspace ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${totals.known.toLocaleString()}+`
            : "Showing 0 workspace documents"}
        </span>
        <label className="document-page-size">
          <span>Rows</span>
          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="table-panel documents-table-panel">
        <table>
          <thead>
            <tr>
              <th>Document</th>
              <th>Type</th>
              <th>Dataset</th>
              <th>Updated</th>
              <th>Evidence</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageDocuments.map((document) => (
              <tr key={document._id}>
                <td>
                  <Link
                    className="document-link"
                    to={`/documents/${encodeURIComponent(document._id)}`}
                    state={{ documentList: `${location.pathname}${location.search}` }}
                  >
                    {documentLabel(document)}
                  </Link>
                  <code>{document._id}</code>
                  {document.summary && <small>{document.summary}</small>}
                </td>
                <td>
                  <span className={`dtype dtype-${document.dtype}`}>{document.dtype}</span>
                </td>
                <td>{document.dataset}</td>
                <td>
                  {document.date_updated ? new Date(document.date_updated).toLocaleString() : "—"}
                </td>
                <td>
                  {document.evidence?.length || 0} evidence · {document.sources?.length || 0}{" "}
                  sources
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Add ${documentLabel(document)} to graph`}
                      title="Add to graph"
                      onClick={() => addLocalDocumentToGraph(document)}
                    >
                      <Network size={15} />
                    </button>
                    <button
                      className="icon-button danger"
                      type="button"
                      aria-label={`Delete ${documentLabel(document)}`}
                      title="Delete document"
                      onClick={() => removeDocument(document)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {liveOnlyRows.length > 0 && (
              <tr className="server-divider-row">
                <td colSpan={6}>
                  <span className="server-divider-label">
                    {query
                      ? "On the server — not in your workspace yet"
                      : "On the server — recent ingest (newest first)"}
                  </span>
                  {liveTotal !== null && (
                    <span className="muted">{liveTotal.toLocaleString()} matches</span>
                  )}
                </td>
              </tr>
            )}
            {liveOnlyRows.map((row) => {
              const saving = savingIds.has(row.id);
              return (
                <tr key={row.id} className="server-row">
                  <td>
                    <button
                      type="button"
                      className="document-link link-button"
                      onClick={() => openLiveDocument(row)}
                      title="Open this server record"
                    >
                      {documentLabel(row.document)}
                    </button>
                    <code>{row.id}</code>
                    {row.document.summary && <small>{row.document.summary}</small>}
                  </td>
                  <td>
                    <span className={`dtype dtype-${row.document.dtype}`}>
                      {row.document.dtype}
                    </span>
                  </td>
                  <td>{row.document.dataset}</td>
                  <td>
                    {row.document.date_updated
                      ? new Date(row.document.date_updated).toLocaleString()
                      : "—"}
                  </td>
                  <td>
                    {row.document.evidence?.length || 0} evidence ·{" "}
                    {row.document.sources?.length || 0} sources
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="icon-button"
                        type="button"
                        disabled={saving}
                        aria-label={`Save ${documentLabel(row.document)} to workspace`}
                        title="Save to workspace"
                        onClick={() => saveLiveDocument(row)}
                      >
                        <HardDriveDownload size={15} />
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        disabled={saving}
                        aria-label={`Add ${documentLabel(row.document)} to graph`}
                        title="Save and add to graph"
                        onClick={() => addLiveDocumentToGraph(row)}
                      >
                        <Network size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {liveOnlyRows.length > 0 && !liveSnapshot?.complete && (
              <tr className="server-more-row">
                <td colSpan={6}>
                  <button
                    className="button small"
                    type="button"
                    disabled={loading}
                    onClick={loadMoreServerResults}
                  >
                    Load more from server
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {!pageDocuments.length && !liveOnlyRows.length && (
          <div className="empty-state compact">
            {loading && !pageState
              ? "Loading documents…"
              : hasSearchScope
                ? "No documents match these filters."
                : totals.complete
                  ? "No documents yet. Add a document to get started."
                  : "No documents loaded yet."}
          </div>
        )}
      </div>

      {(error || liveError) && (
        <div className="empty-state compact">
          {[error, liveError].filter(Boolean).join(" · ")}
        </div>
      )}

      {pageDocuments.length > 0 && (
        <nav className="document-pagination" aria-label="Document result pages">
          <button
            className="pagination-button pagination-step"
            type="button"
            onClick={() => setPage(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={16} />
            <span>Previous</span>
          </button>
          <div className="pagination-pages">
            {pages.map((item) =>
              typeof item === "number" ? (
                <button
                  className={`pagination-button${item === page ? " active" : ""}`}
                  type="button"
                  key={item}
                  onClick={() => setPage(item)}
                  aria-current={item === page ? "page" : undefined}
                  aria-label={`Page ${item}`}
                >
                  {item}
                </button>
              ) : (
                <span className="pagination-ellipsis" key={item} aria-hidden="true">
                  …
                </span>
              )
            )}
          </div>
          <button
            className="pagination-button pagination-step"
            type="button"
            onClick={() => setPage(page + 1)}
            disabled={loading || (Boolean(totals.complete) && page >= contiguousPages)}
            aria-label="Next page"
          >
            <span>Next</span>
            <ChevronRight size={16} />
          </button>
          <span className="pagination-status">
            {totals.complete
              ? `Workspace page ${page.toLocaleString()} of ${Math.max(contiguousPages, 1).toLocaleString()}`
              : `Workspace page ${page.toLocaleString()} · more results`}
          </span>
        </nav>
      )}

      {liveView && (
        <LiveDocumentViewer
          view={liveView}
          cpClient={cpClient}
          serverUrl={serverUrl}
          serverToken={serverToken}
          onClose={() => setLiveView(null)}
          onOpenNeighbor={(id) => setLiveView({ id, document: null })}
          onSave={() => saveLiveDocument(
            liveRows.find((row) => row.id === liveView.id) || {
              id: liveView.id,
              raw: liveView.document
            }
          )}
          onAddToGraph={() => addLiveDocumentToGraph(
            liveRows.find((row) => row.id === liveView.id) || {
              id: liveView.id,
              raw: liveView.document
            }
          )}
        />
      )}
    </section>
  );
}

function LiveDocumentViewer({
  view,
  cpClient,
  serverUrl,
  serverToken,
  onClose,
  onOpenNeighbor,
  onSave,
  onAddToGraph
}) {
  const [document, setDocument] = useState(view.document || null);
  const [relations, setRelations] = useState([]);
  const [total, setTotal] = useState(null);
  const [bookmark, setBookmark] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // The neighbors call returns the document too, so one request serves both
  // the viewer and its neighbor list; the relay follows the v1/legacy route.
  useEffect(() => {
    if (!cpClient?.starintelNeighbors) return;
    if (!serverUrl) {
      setError("Configure a StarIntel server in Settings first.");
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    setRelations([]);
    setBookmark(null);
    setDocument(view.document || null);
    (async () => {
      try {
        const result = await cpClient.starintelNeighbors({
          url: serverUrl,
          token: serverToken || undefined,
          id: view.id
        });
        if (!active) return;
        if (result?.document) setDocument(result.document);
        setRelations(result?.relations || []);
        setTotal(typeof result?.total_relations === "number" ? result.total_relations : null);
        setBookmark(result?.bookmark || null);
      } catch (cause) {
        if (active) setError(cause?.message || "Live document lookup failed.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpClient, view.id, serverUrl, serverToken]);

  async function loadMoreRelations() {
    if (!bookmark) return;
    setLoading(true);
    try {
      const result = await cpClient.starintelNeighbors({
        url: serverUrl,
        token: serverToken || undefined,
        id: view.id,
        bookmark
      });
      setRelations((current) => [...current, ...(result?.relations || [])]);
      setBookmark(result?.bookmark || null);
    } catch (cause) {
      setError(cause?.message || "Could not load more relations.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="live-doc-overlay" role="dialog" aria-modal="true" aria-label="Live document">
      <div className="live-doc-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Live ingest · star-server</span>
            <h2>{document ? documentLabel(document) : view.id}</h2>
            <code>{view.id}</code>
          </div>
          <div className="button-row">
            {onSave && (
              <button className="button small" type="button" onClick={onSave}>
                <HardDriveDownload size={14} /> Save to workspace
              </button>
            )}
            {onAddToGraph && (
              <button className="button small primary" type="button" onClick={onAddToGraph}>
                <Network size={14} /> Add to graph
              </button>
            )}
            <button className="icon-button" type="button" aria-label="Close" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        {loading && !document && <p className="muted">Loading document…</p>}
        {error && <p className="muted">{error}</p>}
        {document && (
          <>
            <div className="metadata-grid">
              <KeyValue label="Type">{document.dtype}</KeyValue>
              <KeyValue label="Dataset">{document.dataset}</KeyValue>
              <KeyValue label="Updated">
                {document.date_updated
                  ? new Date(document.date_updated).toLocaleString()
                  : "—"}
              </KeyValue>
            </div>
            <details className="raw-document">
              <summary>Complete canonical JSON</summary>
              <pre>{JSON.stringify(document, null, 2)}</pre>
            </details>
          </>
        )}
        <section className="live-neighbors">
          <h3>
            Neighbors <span>{total === null ? relations.length : `${relations.length} of ${total}`}</span>
          </h3>
          <ul>
            {relations.map((relation) => (
              <li key={relation.id}>
                <span className={`direction direction-${relation.direction}`}>
                  {relation.direction === "subject" ? "→" : "←"}
                </span>
                <em>{relation.predicate || "related"}</em>
                <button
                  className="link-button"
                  type="button"
                  onClick={() => onOpenNeighbor(relation.neighbor)}
                  title={`Fetch ${relation.neighbor}`}
                >
                  {relation.neighbor}
                </button>
              </li>
            ))}
            {!relations.length && !loading && !error && (
              <li className="muted">No relations matched on the server.</li>
            )}
          </ul>
          {bookmark && (
            <button className="button small" type="button" onClick={loadMoreRelations}>
              Load more relations
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function KeyValue({ label, children }) {
  return (
    <div className="key-value">
      <span>{label}</span>
      <strong>{children || "—"}</strong>
    </div>
  );
}

export function DocumentPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const documentList = location.state?.documentList;
  const listPath =
    typeof documentList === "string" && /^\/documents(?:\?|$)/.test(documentList)
      ? documentList
      : "/documents";
  const { documents, cpClient, execute, setNotice } = useQuasar();
  // Prefer the corpus copy when present (instant, already legacy UI shaped);
  // otherwise fetch exactly this record via document.batch instead of
  // requiring the startup corpus drain.
  const corpusDocument = documents.find((item) => item._id === id);
  const lookup = useDocumentLookup(cpClient, id, { skip: Boolean(corpusDocument) });
  const document = presentDocument(corpusDocument || lookup.document);
  const website = safeExternalUrl(document?.data?.website);

  if (!document)
    return (
      <section className="empty-state">
        {lookup.loading ? (
          <>
            <h1>Loading document…</h1>
            <code>{id}</code>
          </>
        ) : (
          <>
            <h1>Document not found</h1>
            <code>{id}</code>
          </>
        )}
        <Link className="button" to={listPath}>
          Back to documents
        </Link>
      </section>
    );

  async function remove() {
    const deleteIds = connectedDocumentIds(documents, [document._id]);
    if (
      !window.confirm(
        `Delete ${document._id} and ${deleteIds.length - 1} connected relation document(s)?`
      )
    )
      return;
    try {
      await execute(
        operation.batch(
          deleteIds.map((item) => operation.remove(item)),
          "Delete corpus documents"
        ),
        `Delete ${deleteIds.length} corpus document(s)`
      );
      navigate(listPath);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  return (
    <article>
      <div className="page-heading document-heading">
        <div>
          <Link className="back-link" to={listPath}>
            <ArrowLeft size={15} /> {listPath === "/documents" ? "Documents" : "Back to results"}
          </Link>
          <span className="eyebrow">
            {document.dtype} · {document.dataset}
          </span>
          <h1>{documentLabel(document)}</h1>
          <code>{document._id}</code>
          {document.summary && <p>{document.summary}</p>}
        </div>
        <div className="button-row">
          <Link
            className="button"
            to={`/graph?graph=all-documents&node=${encodeURIComponent(document._id)}`}
          >
            <Network size={16} /> Graph
          </Link>
          {website && (
            <a className="button" href={website} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> Open website
            </a>
          )}
          <Link
            className="button primary"
            to={`/documents/${encodeURIComponent(document._id)}/edit`}
            state={location.state}
          >
            <Edit3 size={16} /> Edit
          </Link>
          <button className="button danger" onClick={remove}>
            <Trash2 size={16} /> Delete
          </button>
        </div>
      </div>

      <div className="metadata-grid">
        <KeyValue label="Schema">{document.schema_version}</KeyValue>
        <KeyValue label="Version">{document.version}</KeyValue>
        <KeyValue label="Status">{document.status}</KeyValue>
        <KeyValue label="Language">{document.language}</KeyValue>
        <KeyValue label="Added">{new Date(document.date_added).toLocaleString()}</KeyValue>
        <KeyValue label="Updated">{new Date(document.date_updated).toLocaleString()}</KeyValue>
      </div>

      {document.description && (
        <section className="panel">
          <h2>Description</h2>
          <p className="prose">{document.description}</p>
        </section>
      )}

      <section className="panel">
        <h2>Typed data</h2>
        <pre>{JSON.stringify(document.data, null, 2)}</pre>
      </section>

      <div className="two-column">
        <section className="panel">
          <h2>
            Sources <span>{document.sources?.length || 0}</span>
          </h2>
          {(document.sources || []).map((source, index) => (
            <div className="record-list-item" key={source.source_id || source.url || index}>
              <strong>{source.title || source.name || source.url || `Source ${index + 1}`}</strong>
              <small>{source.publisher || source.organization || source.kind}</small>
              {(source.url || source.uri) && (
                <a href={source.url || source.uri} target="_blank" rel="noreferrer">
                  Open source
                </a>
              )}
            </div>
          ))}
          {!document.sources?.length && <p className="muted">No sources.</p>}
        </section>
        <section className="panel">
          <h2>
            Evidence <span>{document.evidence?.length || 0}</span>
          </h2>
          {(document.evidence || []).map((evidence, index) => (
            <div className="record-list-item" key={evidence.evidence_id || index}>
              <strong>
                {evidence.claim || evidence.observation || evidence.kind || `Evidence ${index + 1}`}
              </strong>
              <small>{evidence.role || evidence.status}</small>
              {evidence.excerpt && <p>{evidence.excerpt}</p>}
            </div>
          ))}
          {!document.evidence?.length && <p className="muted">No evidence records.</p>}
        </section>
      </div>

      <details className="panel raw-document">
        <summary>Complete canonical JSON</summary>
        <pre>{JSON.stringify(document, null, 2)}</pre>
      </details>
    </article>
  );
}
