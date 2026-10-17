import { Network, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDatasetCatalog } from "../control-plane/use-dataset-catalog";

export default function DatasetsPage() {
  const { page, error, loading, next, refresh } = useDatasetCatalog();
  const [query, setQuery] = useState("");
  const rows = page?.datasets ?? [];
  const visible = useMemo(() => {
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
        <Link className="button primary" to="/documents/new">
          <Plus size={15} /> Add document
        </Link>
      </div>

      <div className="dataset-command-bar">
        <label className="dataset-search">
          <Search size={16} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter this dataset page"
            placeholder="Filter this page by name or object type…"
          />
        </label>
        <span className="result-count">
          {visible.length} / {rows.length} on this page
        </span>
      </div>

      <div className="button-row">
        <button className="button" disabled={loading} onClick={refresh}>
          Refresh
        </button>
        <button className="button" disabled={loading || !page || page.complete} onClick={next}>
          Next page
        </button>
        {loading && <span role="status">Loading datasets…</span>}
        {error && <span role="alert">{error}</span>}
      </div>
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
                <td>{row.documentCount.toLocaleString()}</td>
                <td>
                  <div className="dataset-types">
                    {row.types.slice(0, 6).map((type) => (
                      <span key={type}>{type}</span>
                    ))}
                    {row.types.length > 6 && <span>+{row.types.length - 6}</span>}
                  </div>
                </td>
                <td>
                  {row.updatedAt !== null ? new Date(row.updatedAt * 1000).toLocaleString() : "—"}
                </td>
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
        {!loading && !error && !visible.length && (
          <div className="empty-state compact">No matching datasets.</div>
        )}
      </div>
    </section>
  );
}
