import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  ExternalLink,
  Network,
  Plus,
  Search,
  Trash2,
  X
} from "lucide-react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { dtypes } from "starintel_doc";
import { documentLabel } from "starintel_doc/legacy";
import { toLegacyUiDocument } from "../lib/canonical-document";
import { connectedDocumentIds } from "../lib/document-delete";
import { documentsToJsonl, documentsToHistoricalJsonl, downloadText } from "../lib/importer";
import { operation } from "../lib/operations";
import {
  createRouteQueryCache,
  normalizeSearchQuery,
  searchQueryKey
} from "../lib/route-query-cache";
import DatasetsPage from "./DatasetsPage";
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

export function DocumentsPage() {
  const { documents, execute, setNotice, createGraph, addDocumentsToActiveGraph, cpClient } =
    useQuasar();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") || "";
  const dtype = params.get("dtype") || "";
  const dataset = params.get("dataset") || "";
  const group = params.get("group") || "";
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

  useEffect(() => {
    if (!cpClient?.documentSearch) return;
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

  // `complete` reports scope exhaustion, never page fullness; totals count
  // cached rows only, so an incomplete scope renders as "N+".
  const totals = documentsRouteCache.totals(searchQuery);
  const contiguousPages = totals.pages;
  const reachablePages = totals.complete ? contiguousPages : contiguousPages + 1;
  const page = Math.min(requestedPage, Math.max(reachablePages, 1));
  const pageDocuments = pageState?.documents || [];
  const pageStart = pageDocuments.length ? (pageState.pageNumber - 1) * pageSize + 1 : 0;
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

  if (group === "dataset") {
    return <DatasetsPage />;
  }

  return (
    <section className="documents-workspace">
      <div className="page-heading documents-heading">
        <div>
          <span className="eyebrow">Corpus</span>
          <h1>Documents</h1>
          <p>Search and inspect the local StarIntel corpus.</p>
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
            <span>{totals.complete && totals.known === 1 ? "result" : "results"}</span>
            {!totals.complete && pageState && (
              <span className="result-hint">more pages available</span>
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
          <label className="document-filter-control document-filter-dataset">
            <span>Dataset</span>
            <select value={dataset} onChange={(event) => set("dataset", event.target.value)}>
              <option value="">All datasets</option>
              {datasetOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {hasSearchScope && (
            <button
              className="button small document-clear-filters"
              type="button"
              onClick={clearFilters}
            >
              <X size={14} /> Clear filters
            </button>
          )}
        </div>
      </div>

      <div className="document-list-meta">
        <span>
          {pageDocuments.length
            ? totals.complete
              ? `Showing ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${totals.known.toLocaleString()}`
              : `Showing ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${totals.known.toLocaleString()}+`
            : "Showing 0 documents"}
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
                  <button
                    className="icon-button danger"
                    type="button"
                    aria-label={`Delete ${documentLabel(document)}`}
                    title="Delete document"
                    onClick={() => removeDocument(document)}
                  >
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!pageDocuments.length && (
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

      {error && <div className="empty-state compact">{error}</div>}

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
            disabled={loading || (totals.complete && page >= contiguousPages)}
            aria-label="Next page"
          >
            <span>Next</span>
            <ChevronRight size={16} />
          </button>
          <span className="pagination-status">
            {totals.complete
              ? `Page ${page.toLocaleString()} of ${Math.max(contiguousPages, 1).toLocaleString()}`
              : `Page ${page.toLocaleString()} · more results`}
          </span>
        </nav>
      )}
    </section>
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
  const { documents, execute, setNotice } = useQuasar();
  const document = documents.find((item) => item._id === id);
  const website = safeExternalUrl(document?.data?.website);

  if (!document)
    return (
      <section className="empty-state">
        <h1>Document not found</h1>
        <code>{id}</code>
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
