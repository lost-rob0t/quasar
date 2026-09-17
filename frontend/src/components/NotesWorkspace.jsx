import { useCallback, useEffect, useMemo, useState } from "react";
import { BookMarked, CalendarDays, Link2, Network, Plus, Trash2 } from "lucide-react";
import ExecutableCodeBlock from "./ExecutableCodeBlock";
import {
  addNoteBlock,
  deleteNoteBlock,
  ensureNotePage,
  ensureTodayJournal,
  findBacklinks,
  listNoteBlocks,
  listNotePages,
  noteGraph,
  updateNoteBlock
} from "../lib/notes-store";

function blockCode(content) {
  const fenced = String(content || "").match(/^```([^\s`]*)\s*\n([\s\S]*?)\n```\s*$/);
  if (fenced) return { language: fenced[1] || "text", source: fenced[2] };
  const org = String(content || "").match(/^#\+begin_src\s+([^\s]+).*\n([\s\S]*?)\n#\+end_src\s*$/i);
  if (org) return { language: org[1], source: org[2] };
  return null;
}

function referencedPages(content) {
  return [...String(content || "").matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1].trim());
}

export default function NotesWorkspace() {
  const [pages, setPages] = useState([]);
  const [selectedPageId, setSelectedPageId] = useState("");
  const [blocks, setBlocks] = useState([]);
  const [backlinks, setBacklinks] = useState([]);
  const [graph, setGraph] = useState({ pages: [], edges: [] });
  const [newPageTitle, setNewPageTitle] = useState("");
  const [error, setError] = useState("");

  const selectedPage = pages.find((page) => page._id === selectedPageId) || null;

  const refreshPages = useCallback(async (selectId) => {
    const nextPages = await listNotePages();
    setPages(nextPages);
    setGraph(await noteGraph());
    setSelectedPageId((current) => selectId || current || nextPages[0]?._id || "");
  }, []);

  const refreshPage = useCallback(async () => {
    if (!selectedPage) {
      setBlocks([]);
      setBacklinks([]);
      return;
    }
    setBlocks(await listNoteBlocks(selectedPage._id));
    setBacklinks(await findBacklinks(selectedPage.title));
    setGraph(await noteGraph());
  }, [selectedPage]);

  useEffect(() => {
    refreshPages().catch((cause) => setError(cause.message || String(cause)));
  }, [refreshPages]);

  useEffect(() => {
    refreshPage().catch((cause) => setError(cause.message || String(cause)));
  }, [refreshPage]);

  async function createPage(event) {
    event.preventDefault();
    const title = newPageTitle.trim();
    if (!title) return;
    try {
      const page = await ensureNotePage(title);
      setNewPageTitle("");
      await refreshPages(page._id);
    } catch (cause) {
      setError(cause.message || String(cause));
    }
  }

  async function openJournal() {
    try {
      const page = await ensureTodayJournal();
      await refreshPages(page._id);
    } catch (cause) {
      setError(cause.message || String(cause));
    }
  }

  async function addBlock(afterOrder = null) {
    if (!selectedPage) return;
    try {
      await addNoteBlock(selectedPage._id, "", afterOrder);
      await refreshPage();
    } catch (cause) {
      setError(cause.message || String(cause));
    }
  }

  async function saveBlock(block, content) {
    try {
      await updateNoteBlock(block, content);
      await refreshPage();
      await refreshPages(selectedPageId);
    } catch (cause) {
      setError(cause.message || String(cause));
    }
  }

  async function removeBlock(block) {
    try {
      await deleteNoteBlock(block);
      await refreshPage();
    } catch (cause) {
      setError(cause.message || String(cause));
    }
  }

  const outgoing = useMemo(() => {
    const values = new Set();
    for (const block of blocks) for (const ref of referencedPages(block.content)) values.add(ref);
    return [...values].sort((a, b) => a.localeCompare(b));
  }, [blocks]);

  function openPageByTitle(title) {
    const found = pages.find((page) => page.title.toLowerCase() === title.toLowerCase());
    if (found) {
      setSelectedPageId(found._id);
      return;
    }
    ensureNotePage(title)
      .then((page) => refreshPages(page._id))
      .catch((cause) => setError(cause.message || String(cause)));
  }

  return (
    <section className="notes-workspace">
      <aside className="notes-sidebar">
        <header>
          <div className="eyebrow">Local-first knowledge base</div>
          <h1>
            <BookMarked size={22} /> Notes
          </h1>
        </header>
        <button type="button" className="button secondary" onClick={openJournal}>
          <CalendarDays size={15} /> Today's journal
        </button>
        <form className="notes-new-page" onSubmit={createPage}>
          <input
            aria-label="New page title"
            value={newPageTitle}
            onChange={(event) => setNewPageTitle(event.target.value)}
            placeholder="New page"
          />
          <button className="button compact" type="submit" disabled={!newPageTitle.trim()}>
            <Plus size={14} />
          </button>
        </form>
        <nav aria-label="Note pages" className="notes-page-list">
          {pages.map((page) => (
            <button
              type="button"
              key={page._id}
              className={page._id === selectedPageId ? "active" : ""}
              onClick={() => setSelectedPageId(page._id)}
            >
              {page.kind === "journal" ? <CalendarDays size={14} /> : <BookMarked size={14} />}
              <span>{page.title}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="notes-editor page-card">
        {error ? <div className="notice error">{error}</div> : null}
        {selectedPage ? (
          <>
            <header className="notes-page-header">
              <div className="eyebrow">{selectedPage.kind === "journal" ? "Journal" : "Page"}</div>
              <h1>{selectedPage.title}</h1>
              <p>
                <Network size={14} /> {blocks.length} blocks · {outgoing.length} outgoing refs · {backlinks.length} backlinks
              </p>
            </header>

            <section className="notes-blocks" aria-label="Page blocks">
              {blocks.map((block) => {
                const code = blockCode(block.content);
                return (
                  <article className="note-block" key={block._id}>
                    <div className="note-block-bullet" title={block._id} />
                    <div className="note-block-body">
                      <textarea
                        defaultValue={block.content}
                        aria-label="Note block"
                        rows={Math.max(1, block.content.split("\n").length)}
                        onBlur={(event) => {
                          if (event.target.value !== block.content) saveBlock(block, event.target.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            saveBlock(block, event.currentTarget.value).then(() => addBlock(block.order));
                          }
                        }}
                      />
                      {code ? <ExecutableCodeBlock language={code.language} source={code.source} /> : null}
                      {referencedPages(block.content).length ? (
                        <div className="note-block-refs">
                          {referencedPages(block.content).map((title) => (
                            <button type="button" key={title} onClick={() => openPageByTitle(title)}>
                              <Link2 size={12} /> {title}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <button type="button" className="icon-button" title="Delete block" onClick={() => removeBlock(block)}>
                      <Trash2 size={14} />
                    </button>
                  </article>
                );
              })}
              <button type="button" className="button secondary" onClick={() => addBlock()}>
                <Plus size={14} /> Add block
              </button>
            </section>

            <section className="notes-links-panel">
              <div>
                <h2>Linked references</h2>
                {outgoing.length ? (
                  outgoing.map((title) => (
                    <button type="button" key={title} onClick={() => openPageByTitle(title)}>
                      [[{title}]]
                    </button>
                  ))
                ) : (
                  <p>No page references yet. Type `[[Page Name]]` in a block.</p>
                )}
              </div>
              <div>
                <h2>Backlinks</h2>
                {backlinks.length ? (
                  backlinks.map((block) => {
                    const sourcePage = pages.find((page) => page._id === block.pageId);
                    return (
                      <button type="button" key={block._id} onClick={() => sourcePage && setSelectedPageId(sourcePage._id)}>
                        <strong>{sourcePage?.title || "Unknown page"}</strong>
                        <span>{block.content.slice(0, 140)}</span>
                      </button>
                    );
                  })
                ) : (
                  <p>No backlinks to this page.</p>
                )}
              </div>
              <div>
                <h2>Knowledge graph</h2>
                <p>{graph.pages.length} pages · {graph.edges.length} page-reference edges</p>
              </div>
            </section>
          </>
        ) : (
          <div className="empty-state">
            <BookMarked size={28} />
            <h2>Create your first page</h2>
            <p>Pages contain addressable blocks, journals, links, tags, code blocks, and backlinks.</p>
          </div>
        )}
      </main>
    </section>
  );
}
