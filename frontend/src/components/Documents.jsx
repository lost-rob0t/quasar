import { useMemo } from "react";
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
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { dtypes, documentLabel } from "starintel_doc";
import { connectedDocumentIds } from "../lib/document-delete";
import { graphRenderDecision } from "../lib/graph-scale";
import { documentsToJsonl, downloadText } from "../lib/importer";
import { operation } from "../lib/operations";
import { useQuasar } from "../store";

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZES = [25, 50, 100, 250];

function includesDocument(document, query) {
  if (!query) return true;
  const text =
    `${document._id} ${document.dataset} ${document.dtype} ${document.title || ""} ${document.summary || ""} ${JSON.stringify(document.data)} ${JSON.stringify(document.sources || [])}`.toLowerCase();
  return text.includes(query.toLowerCase());
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function datasetRows(documents) {
  const rows = new Map();
  documents.forEach((document) => {
    const name = String(document.dataset || "").trim();
    if (!name) return;
    const current = rows.get(name) || {
      name,
      documents: 0,
      types: new Set(),
      updatedAt: 0
    };
    current.documents += 1;
    if (document.dtype) current.types.add(document.dtype);
    current.updatedAt = Math.max(current.updatedAt, Date.parse(document.date_updated) || 0);
    rows.set(name, current);
  });
  return [...rows.values()]
    .map((row) => ({ ...row, types: [...row.types].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
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

function DatasetsPage({ documents, query, setQuery }) {
  const rows = useMemo(() => datasetRows(documents), [documents]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return rows;
    return rows.filter((row) =>
      `${row.name} ${row.types.join(" ")}`.toLowerCase().includes(normalized)
    );
  }, [query, rows]);

  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Corpus</span>
          <h1>Datasets</h1>
          <p>Browse the datasets represented in the local StarIntel corpus.</p>
        </div>
        <Link className="button primary" to="/documents/new">
          <Plus size={16} /> Add document
        </Link>
      </div>

      <div className="filter-bar">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search datasets"
          placeholder="Search datasets"
        />
        <span className="result-count">
          {visible.length} / {rows.length}
        </span>
      </div>

      <div className="table-panel">
        <table>
          <thead>
            <tr>
              <th>Dataset</th>
              <th>Documents</th>
              <th>Object types</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.name}>
                <td>
                  <strong>{row.name}</strong>
                </td>
                <td>{row.documents}</td>
                <td>{row.types.join(", ") || "—"}</td>
                <td>{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "—"}</td>
                <td>
                  <div className="button-row">
                    <Link
                      className="button small"
                      to={`/documents?dataset=${encodeURIComponent(row.name)}`}
                    >
                      Open documents
                    </Link>
                    <Link
                      className="button small"
                      to={`/graph?graph=all-documents&dataset=${encodeURIComponent(row.name)}&review=all`}
                    >
                      <Network size={15} /> Open graph
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && <div className="empty-state compact">No matching datasets.</div>}
      </div>
    </section>
  );
}

export function DocumentsPage() {
  const { documents, execute, setNotice, createGraph, addDocumentsToActiveGraph } = useQuasar();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") || "";
  const dtype = params.get("dtype") || "";
  const dataset = params.get("dataset") || "";
  const group = params.get("group") || "";
  const requestedPage = parsePage(params.get("page"));
  const pageSize = parsePageSize(params.get("perPage"));
  const hasSearchScope = Boolean(query || dtype || dataset);
  const datasets = useMemo(
    () => [...new Set(documents.map((document) => document.dataset).filter(Boolean))].sort(),
    [documents]
  );
  const visible = useMemo(
    () =>
      documents.filter(
        (document) =>
          (!dtype || document.dtype === dtype) &&
          (!dataset || document.dataset === dataset) &&
          includesDocument(document, query)
      ),
    [documents, dtype, dataset, query]
  );

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const pageStart = visible.length ? (page - 1) * pageSize : 0;
  const pageEnd = Math.min(pageStart + pageSize, visible.length);
  const pageDocuments = useMemo(
    () => visible.slice(pageStart, pageEnd),
    [visible, pageStart, pageEnd]
  );
  const pages = useMemo(() => paginationRange(page, pageCount), [page, pageCount]);
  const graphDecision = useMemo(() => graphRenderDecision(visible), [visible]);

  const set = (key, value, { resetPage = true } = {}) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (resetPage) next.delete("page");
    setParams(next);
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

  function importSearchToGraph() {
    if (!hasSearchScope || !visible.length || !graphDecision.allowed) return;
    try {
      const scope = query || dataset || dtype;
      createGraph(`Search: ${scope}`);
      const importedIds = visible.map((document) => document._id);
      addDocumentsToActiveGraph(importedIds);
      navigate("/graph?review=all", {
        state: {
          importedIds,
          revealUnreviewed: true,
          source: "search-results"
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
    return (
      <DatasetsPage documents={documents} query={query} setQuery={(value) => set("q", value)} />
    );
  }

  return (
    <section className="documents-workspace">
      <div className="page-heading documents-heading">
        <div>
          <span className="eyebrow">Corpus</span>
          <h1>Documents</h1>
          <p>Search and inspect the local StarIntel v0.9 corpus.</p>
        </div>
        <div className="button-row">
          <button
            className="button"
            onClick={importSearchToGraph}
            disabled={!hasSearchScope || !visible.length || !graphDecision.allowed}
            title={
              !hasSearchScope
                ? "Search or filter the corpus before importing results"
                : graphDecision.allowed
                  ? "Create a graph from the current search results"
                  : "Narrow the search before importing it into a graph"
            }
          >
            <Network size={16} /> Import results to graph
          </button>
          <button
            className="button"
            onClick={() => downloadText("starintel-documents.jsonl", documentsToJsonl(visible))}
          >
            <Download size={16} /> Export results
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
              onChange={(event) => set("q", event.target.value)}
              aria-label="Search documents"
              placeholder="Search names, IDs, summaries, sources, and document fields…"
              autoComplete="off"
            />
            {query && (
              <button
                className="document-search-clear"
                type="button"
                onClick={() => set("q", "")}
                title="Clear search"
                aria-label="Clear document search"
              >
                <X size={16} />
              </button>
            )}
          </div>
          <div className="document-result-summary" aria-live="polite">
            <strong>{visible.length.toLocaleString()}</strong>
            <span>{visible.length === 1 ? "result" : "results"}</span>
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
              {datasets.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {hasSearchScope && (
            <button className="button small document-clear-filters" type="button" onClick={clearFilters}>
              <X size={14} /> Clear filters
            </button>
          )}
        </div>
      </div>

      <div className="document-list-meta">
        <span>
          {visible.length
            ? `Showing ${(pageStart + 1).toLocaleString()}–${pageEnd.toLocaleString()} of ${visible.length.toLocaleString()}`
            : "No matching documents"}
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
                <td>{new Date(document.date_updated).toLocaleString()}</td>
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
        {!visible.length && <div className="empty-state compact">No matching documents.</div>}
      </div>

      {visible.length > 0 && (
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
            disabled={page >= pageCount}
            aria-label="Next page"
          >
            <span>Next</span>
            <ChevronRight size={16} />
          </button>
          <span className="pagination-status">
            Page {page.toLocaleString()} of {pageCount.toLocaleString()}
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
  const navigate = useNavigate();
  const { documents, execute, setNotice } = useQuasar();
  const document = documents.find((item) => item._id === id);
  const website = safeExternalUrl(document?.data?.website);

  if (!document)
    return (
      <section className="empty-state">
        <h1>Document not found</h1>
        <code>{id}</code>
        <Link className="button" to="/documents">
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
      navigate("/documents");
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  return (
    <article>
      <div className="page-heading document-heading">
        <div>
          <Link className="back-link" to="/documents">
            <ArrowLeft size={15} /> Documents
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
