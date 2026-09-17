import { useEffect, useMemo, useState } from "react";
import { BookOpen, Download, Search } from "lucide-react";
import {
  cacheDocumentationSet,
  documentationCacheStats,
  loadDocumentationSource
} from "../lib/docs-cache";
import OrgDocument from "./OrgDocument";

const INDEX_URL = "/quasar-docs/index.json";

export default function DocsWorkspace() {
  const [index, setIndex] = useState({ documents: [] });
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [source, setSource] = useState("");
  const [sourceCached, setSourceCached] = useState(false);
  const [cacheStats, setCacheStats] = useState({ cached: 0 });
  const [cacheProgress, setCacheProgress] = useState(null);
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
    documentationCacheStats()
      .then((stats) => !cancelled && setCacheStats(stats))
      .catch(() => {});
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
      setSourceCached(false);
      return;
    }
    let cancelled = false;
    setSource("");
    setSourceCached(false);
    setError("");
    loadDocumentationSource(selected)
      .then((value) => {
        if (cancelled) return;
        setSource(value.source);
        setSourceCached(value.cached);
        documentationCacheStats().then(setCacheStats).catch(() => {});
      })
      .catch((cause) => !cancelled && setError(cause.message || String(cause)));
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.asset]);

  async function downloadAll() {
    if (!index.documents.length || cacheProgress) return;
    setError("");
    setCacheProgress({ completed: 0, total: index.documents.length, failures: 0 });
    try {
      const report = await cacheDocumentationSet(index.documents, setCacheProgress);
      setCacheStats(await documentationCacheStats());
      if (report.failures.length) {
        setError(`${report.failures.length} documentation files could not be cached. Retry while online.`);
      }
    } catch (cause) {
      setError(cause.message || String(cause));
    } finally {
      setCacheProgress(null);
    }
  }

  return (
    <section className="docs-workspace">
      <aside className="docs-sidebar">
        <header>
          <div className="eyebrow">Packaged reference</div>
          <h1>
            <BookOpen size={22} /> Documentation
          </h1>
        </header>
        <button
          type="button"
          className="button secondary"
          onClick={downloadAll}
          disabled={!index.documents.length || Boolean(cacheProgress)}
        >
          <Download size={15} />
          {cacheProgress
            ? `Caching ${cacheProgress.completed}/${cacheProgress.total}`
            : `Make all docs offline (${cacheStats.cached}/${index.documents.length})`}
        </button>
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
              <small>
                {document.sectionLabel} · {document.path}
                {document.remote ? " · pinned remote" : ""}
              </small>
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
              <p>
                {selected.path}
                {sourceCached ? " · offline copy" : ""}
                {selected.revision ? ` · ${selected.revision.slice(0, 12)}` : ""}
              </p>
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
