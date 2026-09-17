import { useEffect, useMemo, useState } from "react";
import { BookOpen, Search } from "lucide-react";
import OrgDocument from "./OrgDocument";

const INDEX_URL = "/quasar-docs/index.json";

export default function DocsWorkspace() {
  const [index, setIndex] = useState({ documents: [] });
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(INDEX_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`Documentation index returned ${response.status}`);
        return response.json();
      })
      .then((value) => {
        if (cancelled) return;
        const documents = Array.isArray(value?.documents) ? value.documents : [];
        setIndex({ ...value, documents });
        setSelectedId((current) => current || documents[0]?.id || "");
      })
      .catch((cause) => !cancelled && setError(cause.message || String(cause)));
    return () => {
      cancelled = true;
    };
  }, []);

  const documents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return index.documents;
    return index.documents.filter((document) =>
      [document.title, document.path, document.sectionLabel, document.summary]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [index.documents, query]);

  const selected = index.documents.find((document) => document.id === selectedId) || null;

  useEffect(() => {
    if (!selected?.asset) {
      setSource("");
      return;
    }
    let cancelled = false;
    setSource("");
    setError("");
    fetch(selected.asset)
      .then((response) => {
        if (!response.ok) throw new Error(`Documentation source returned ${response.status}`);
        return response.text();
      })
      .then((value) => !cancelled && setSource(value))
      .catch((cause) => !cancelled && setError(cause.message || String(cause)));
    return () => {
      cancelled = true;
    };
  }, [selected?.asset]);

  return (
    <section className="docs-workspace">
      <aside className="docs-sidebar">
        <header>
          <div className="eyebrow">Packaged reference</div>
          <h1>
            <BookOpen size={22} /> Documentation
          </h1>
        </header>
        <label className="docs-search">
          <Search size={16} />
          <input
            aria-label="Search documentation"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search docs, wiki, learn…"
          />
        </label>
        <nav className="docs-index" aria-label="Documentation files">
          {documents.map((document) => (
            <button
              type="button"
              key={document.id}
              className={document.id === selectedId ? "active" : ""}
              onClick={() => setSelectedId(document.id)}
            >
              <span>{document.title}</span>
              <small>{document.sectionLabel} · {document.path}</small>
            </button>
          ))}
        </nav>
      </aside>
      <main className="docs-reader page-card">
        {error ? <div className="notice error">{error}</div> : null}
        {selected ? (
          <>
            <header className="docs-reader-header">
              <div className="eyebrow">{selected.sectionLabel}</div>
              <h1>{selected.title}</h1>
              <p>{selected.path}</p>
            </header>
            {source ? <OrgDocument source={source} /> : <p>Loading documentation…</p>}
          </>
        ) : (
          <div className="empty-state">
            <BookOpen size={28} />
            <h2>No documentation packaged</h2>
            <p>Run the documentation bundler before building the production UI.</p>
          </div>
        )}
      </main>
    </section>
  );
}
