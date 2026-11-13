import { Network, Plus, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuasar } from "../store";

function catalogRows(datasets) {
  return (datasets || [])
    .map((row) => ({
      name: String(row.name || "").trim(),
      documents: Number(row.documentCount) || 0,
      types: Object.entries(row.dtypes || {})
        .filter(([, count]) => count > 0)
        .map(([type]) => type)
        .sort(),
      updatedAt: (Number(row.lastWriteAt) || 0) * 1000
    }))
    .filter((row) => row.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export default function DatasetsPage() {
  const { documents = [], cpClient } = useQuasar();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");

  const loadRows = useCallback(async () => {
    if (!cpClient?.workspaceBootstrap) return;
    try {
      const bootstrap = await cpClient.workspaceBootstrap();
      setRows(catalogRows(bootstrap?.datasets));
      setError(null);
    } catch (cause) {
      setError(cause?.message || "The dataset catalog is unavailable.");
    }
  }, [cpClient]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  // Transitional freshness: the store still publishes corpus changes while
  // the startup snapshot drain remains (next migration slice). Re-read the
  // compact catalog whenever the corpus identity changes.
  const corpusVersion = documents.length;
  useEffect(() => {
    if (rows) void loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corpusVersion]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return rows;
    return rows.filter((row) =>
      `${row.name} ${row.types.join(" ")}`.toLowerCase().includes(normalized)
    );
  }, [query, rows]);

  return (
    <section className="datasets-workspace">
      <div className="page-heading compact-heading">
        <div>
          <span className="eyebrow">Corpus</span>
          <h1>Datasets</h1>
          <p>
            Browse corpus partitions, inspect their object mix, or open one directly as a graph.
          </p>
        </div>
        <div className="button-row">
          <button className="button" type="button" onClick={() => void loadRows()}>
            <RefreshCw size={15} /> Refresh
          </button>
          <Link className="button primary" to="/documents/new">
            <Plus size={15} /> Add document
          </Link>
        </div>
      </div>

      <div className="dataset-command-bar">
        <label className="dataset-search">
          <Search size={16} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search datasets"
            placeholder="Filter datasets by name or object type…"
          />
        </label>
        {query && (
          <button className="button small" type="button" onClick={() => setQuery("")}>
            <X size={14} aria-hidden="true" /> Clear search
          </button>
        )}
        {rows && (
          <span className="result-count">
            {visible.length} / {rows.length}
          </span>
        )}
      </div>

      {error ? (
        <div className="empty-state compact">{error}</div>
      ) : (
        <div className="table-panel datasets-table-panel">
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
                    <Link
                      className="dataset-name"
                      to={`/documents?dataset=${encodeURIComponent(row.name)}`}
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td>{row.documents.toLocaleString()}</td>
                  <td>
                    <div className="dataset-types">
                      {row.types.slice(0, 6).map((type) => (
                        <span key={type}>{type}</span>
                      ))}
                      {row.types.length > 6 && <span>+{row.types.length - 6}</span>}
                    </div>
                  </td>
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
                        <Network size={14} /> Open graph
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows && !visible.length && (
            <div className="empty-state compact">
              {rows.length
                ? "No datasets match this search."
                : "No datasets yet. Add a document to get started."}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
