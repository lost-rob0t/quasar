import { Network, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuasar } from "../store";

function datasetRows(documents) {
  const rows = new Map();
  for (const document of documents) {
    const name = String(document.dataset || "").trim();
    if (!name) continue;
    const current = rows.get(name) || {
      name,
      documents: 0,
      types: new Set(),
      updatedAt: 0
    };
    current.documents += 1;
    if (document.dtype) current.types.add(document.dtype);
    current.updatedAt = Math.max(
      current.updatedAt,
      Date.parse(document.date_updated) || 0
    );
    rows.set(name, current);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, types: [...row.types].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export default function DatasetsPage() {
  const { documents = [] } = useQuasar();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => datasetRows(documents), [documents]);
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
            aria-label="Search datasets"
            placeholder="Filter datasets by name or object type…"
          />
        </label>
        <span className="result-count">
          {visible.length} / {rows.length}
        </span>
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
        {!visible.length && <div className="empty-state compact">No matching datasets.</div>}
      </div>
    </section>
  );
}
