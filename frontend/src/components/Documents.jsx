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
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { dtypes } from "starintel_doc";
import { documentLabel } from "starintel_doc/legacy";
import {
  relatedDeletionIds,
  exportDocumentResults,
  graphDocumentsForScope
} from "../control-plane/document-actions";
import { getControlPlaneOrThrow } from "../control-plane/client";
import { useDocumentList } from "../control-plane/use-document-list";
import { useDatasetCatalog } from "../control-plane/use-dataset-catalog";
import DatasetsPage from "./DatasetsPage";
import { useCanonicalDocument } from "../control-plane/use-canonical-document";
import { toLegacyUiDocument } from "../lib/canonical-document";
import { operation } from "../lib/operations";
import { useQuasar } from "../store";

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZES = [25, 50, 100, 250];

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

export function DocumentsPage() {
  const { execute, setNotice, createGraph, addDocumentsToActiveGraph, exportDocuments } =
    useQuasar();
  const exportController = useRef(null);
  const exportMounted = useRef(true);
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    exportMounted.current = true;
    return () => {
      exportMounted.current = false;
      exportController.current?.abort();
    };
  }, []);
  const exportWorkspace = async () => {
    if (exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    try {
      const result = await exportDocuments({ signal: controller.signal });
      if (!controller.signal.aborted)
        setNotice({
          kind: "success",
          message: `Exported ${result.count} canonical documents at workspace revision ${result.revision}.`
        });
    } catch (error) {
      if (!controller.signal.aborted && error.name !== "AbortError")
        setNotice({ kind: "error", message: error.message });
    } finally {
      exportController.current = null;
      if (exportMounted.current) setExporting(false);
    }
  };
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") || "";
  const dtype = params.get("dtype") || "";
  const dataset = params.get("dataset") || "";
  const group = params.get("group") || "";
  const pageSize = parsePageSize(params.get("perPage"));
  const hasSearchScope = Boolean(query || dtype || dataset);
  const scope = { q: query, dtype, dataset };
  const {
    page: result,
    loading,
    error,
    next: nextPage,
    refresh: firstPage
  } = useDocumentList(scope, pageSize);
  const catalog = useDatasetCatalog();
  const pageDocuments = useMemo(() => (result?.documents || []).map(toLegacyUiDocument), [result]);
  const datasets = catalog.page?.datasets || [];
  const exportResults = async (historical = false) => {
    try {
      await exportDocumentResults(getControlPlaneOrThrow(), scope, historical);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  };

  const set = (key, value, { resetPage = true } = {}) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (resetPage) next.delete("page");
    setParams(next);
  };

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

  async function importSearchToGraph() {
    if (!hasSearchScope) return;
    try {
      const matches = await graphDocumentsForScope(getControlPlaneOrThrow(), scope);
      if (!matches.length) return;
      createGraph(`Search: ${query || dataset || dtype}`);
      const importedIds = matches.map((document) => document._id);
      addDocumentsToActiveGraph(importedIds);
      navigate("/graph?review=all", {
        state: { importedIds, revealUnreviewed: true, source: "search-results" }
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function removeDocument(document) {
    try {
      const { ids: deleteIds, revision } = await relatedDeletionIds(
        getControlPlaneOrThrow(),
        document._id
      );
      if (
        !window.confirm(
          `Delete ${document._id} and ${deleteIds.length - 1} connected relation document(s)?`
        )
      )
        return;
      await execute(
        operation.batch(
          deleteIds.map((id) => operation.remove(id)),
          "Delete corpus documents"
        ),
        `Delete ${deleteIds.length} corpus document(s)`,
        { expectedRevision: revision }
      );
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  if (group === "dataset") return <DatasetsPage />;

  return (
    <section className="documents-workspace">
      <div className="page-heading documents-heading">
        <div>
          <span className="eyebrow">Corpus</span>
          <h1>Documents</h1>
          <p>Search and inspect canonical StarIntel documents.</p>
        </div>
        <div className="button-row">
          <button
            className="button"
            onClick={importSearchToGraph}
            disabled={!hasSearchScope || loading}
            title="Create a graph from all matching results within the graph rendering limits"
          >
            <Network size={16} /> Import results to graph
          </button>
          <button className="button" onClick={() => exportResults()}>
            <Download size={16} /> Export results
          </button>
          <button type="button" className="button" onClick={() => exportResults(true)}>
            Export historical archive
          </button>
          <button type="button" className="button" onClick={exportWorkspace} disabled={exporting}>
            <Download size={16} /> {exporting ? "Exporting workspace…" : "Export workspace"}
          </button>
          {exporting ? (
            <button
              type="button"
              className="button"
              onClick={() => {
                exportController.current?.abort();
              }}
            >
              Cancel export
            </button>
          ) : null}
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
            <strong>{pageDocuments.length.toLocaleString()}</strong>
            <span>
              {pageDocuments.length === 1 ? "result on this page" : "results on this page"}
            </span>
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
            <input
              value={dataset}
              onChange={(event) => set("dataset", event.target.value)}
              list="document-datasets"
              placeholder="All datasets"
            />
            <datalist id="document-datasets">
              {datasets.map((row) => (
                <option key={row.name} value={row.name} />
              ))}
            </datalist>
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
          {loading
            ? "Loading documents…"
            : `${pageDocuments.length} matching documents on this page${result && !result.complete ? "; more pages available" : ""}`}
          {error && <span role="alert">{error}</span>}
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
        {!loading && !error && !pageDocuments.length && (
          <div className="empty-state compact">
            {result?.complete
              ? "No matching documents on this page."
              : "No matches in this part of the corpus. Continue to the next page."}
          </div>
        )}
      </div>

      <nav className="document-pagination" aria-label="Document result pages">
        <button
          className="pagination-button pagination-step"
          onClick={firstPage}
          disabled={loading}
          aria-label="First page"
        >
          <ChevronLeft size={16} /> First page
        </button>
        <button
          className="pagination-button pagination-step"
          onClick={nextPage}
          disabled={loading || !result || result.complete}
          aria-label="Next page"
        >
          Next <ChevronRight size={16} />
        </button>
      </nav>
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
  const { execute, setNotice } = useQuasar();
  const lookup = useCanonicalDocument(id);
  const document = useMemo(
    () => (lookup.document ? toLegacyUiDocument(lookup.document) : null),
    [lookup.document]
  );
  const website = safeExternalUrl(document?.data?.website);

  if (lookup.status === "loading") return <p role="status">Loading document…</p>;
  if (lookup.status === "error") return <p role="alert">{lookup.error}</p>;
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
    try {
      const { ids: deleteIds, revision } = await relatedDeletionIds(
        getControlPlaneOrThrow(),
        document._id
      );
      if (
        !window.confirm(
          `Delete ${document._id} and ${deleteIds.length - 1} connected relation document(s)?`
        )
      )
        return;
      await execute(
        operation.batch(
          deleteIds.map((id) => operation.remove(id)),
          "Delete corpus documents"
        ),
        `Delete ${deleteIds.length} corpus document(s)`,
        { expectedRevision: revision }
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
