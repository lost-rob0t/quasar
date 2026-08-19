import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Database,
  Menu,
  Plus,
  Redo2,
  Search,
  Sparkles,
  Undo2,
  UserRound
} from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import MobileGestureMenu from "../components/MobileGestureMenu";
import { useQuasar } from "../store";
import { navigation } from "./navigation";
import StatusCenter from "./StatusCenter";
import { useUiRuntime } from "./runtime";

function loadSidebarCollapsed() {
  try {
    return globalThis.localStorage?.getItem("quasar:sidebar-collapsed") === "1";
  } catch {
    return false;
  }
}

function NavigationLinks({ mobile = false, pathname }) {
  return navigation
    .filter((item) => !mobile || item.mobileLabel)
    .map(({ to, label, mobileLabel, Icon, match }) => {
      const active = match(pathname);
      return (
        <Link
          key={to}
          to={to}
          className={active ? "nav-link active" : "nav-link"}
          aria-current={active ? "page" : undefined}
        >
          <Icon size={mobile ? 20 : 17} aria-hidden="true" />
          <span>{mobile ? mobileLabel : label}</span>
        </Link>
      );
    });
}

function SidebarGraphs({ graphs, activeGraph, switchGraph, createGraph }) {
  function addGraph() {
    const name = window.prompt("Graph name", "Untitled graph");
    if (!name?.trim()) return;
    createGraph(name.trim());
  }

  return (
    <section className="sidebar-context" aria-label="Graph workspace">
      <div className="sidebar-section-label">Workspace</div>
      <div className="workspace-selector" aria-label="Current workspace">
        <Database size={15} />
        <span>OSINT Workspace</span>
      </div>
      <div className="sidebar-section-row">
        <span className="sidebar-section-label">Graphs</span>
        <button
          className="sidebar-add"
          type="button"
          aria-label="Create graph"
          onClick={addGraph}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="sidebar-graph-list" aria-label="Workspace graphs">
        {graphs.map((graph) => {
          const active = graph.id === activeGraph?.id;
          return (
            <button
              key={graph.id}
              className={active ? "sidebar-graph-row active" : "sidebar-graph-row"}
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => switchGraph(graph.id)}
              title={graph.name}
            >
              <span>{graph.name}</span>
              {active && <span className="sidebar-current-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Notice({ notice, onDismiss }) {
  if (!notice) return null;
  return (
    <div className={`notice notice-${notice.kind || "info"}`} role="status">
      <span>{notice.message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification">
        ×
      </button>
    </div>
  );
}

export default function QuasarShell({ children }) {
  const runtime = useUiRuntime();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    loading,
    notice,
    setNotice,
    canUndo,
    canRedo,
    undo,
    redo,
    documents = [],
    graphs = [],
    activeGraph,
    switchGraph,
    createGraph
  } = useQuasar();
  const [query, setQuery] = useState("");
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const graphRoute =
    location.pathname === "/graph" || location.pathname.startsWith("/graph/");

  function submitSearch(event) {
    event.preventDefault();
    const value = query.trim();
    navigate(value ? `/documents?q=${encodeURIComponent(value)}` : "/documents");
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        globalThis.localStorage?.setItem("quasar:sidebar-collapsed", next ? "1" : "0");
      } catch {
        // Browser storage is optional.
      }
      return next;
    });
  }

  async function runHistory(action) {
    try {
      await action();
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  return (
    <div
      className={`app-shell quasar-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
      data-runtime={runtime.id}
    >
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            ✦
          </div>
          <div className="brand-copy">
            <strong>Quasar</strong>
            <span>{runtime.workspaceLabel}</span>
          </div>
          <button
            className="icon-button sidebar-collapse"
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <div className="sidebar-section-label">Navigation</div>
        <nav aria-label="Primary navigation">
          <NavigationLinks pathname={location.pathname} />
        </nav>

        {graphRoute && (
          <SidebarGraphs
            graphs={graphs}
            activeGraph={activeGraph}
            switchGraph={switchGraph}
            createGraph={createGraph}
          />
        )}

        <div className="sidebar-foot">
          <div className="sidebar-corpus-count">
            <Database size={14} />
            <span>{documents.length.toLocaleString()} documents</span>
          </div>
          <div className="sidebar-runtime-label">{runtime.label}</div>
          <div className="sidebar-user">
            <UserRound size={17} />
            <span>
              <strong>unseen</strong>
              <small>Admin</small>
            </span>
          </div>
        </div>
      </aside>

      <section className="workbench">
        <header className="topbar">
          <button
            className="icon-button mobile-menu-button"
            type="button"
            aria-label="Open menu"
            aria-expanded={mobileNavigationOpen}
            onClick={() => setMobileNavigationOpen(true)}
          >
            <Menu size={20} aria-hidden="true" />
          </button>

          <form className="global-search" onSubmit={submitSearch} role="search">
            <Search size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search workspace"
              placeholder="Search everything…"
            />
          </form>

          <div className="top-actions">
            <StatusCenter />
            <Link className="button top-agent-action" to="/agents?tab=run">
              <Sparkles size={15} />
              <span>AI Agent</span>
            </Link>
            <Link
              className="icon-button"
              to="/documents/new"
              title="Create document"
              aria-label="Create document"
            >
              <Plus size={17} />
            </Link>
            <button className="icon-button" type="button" title="Help" aria-label="Help">
              <CircleHelp size={17} />
            </button>
            <button
              className="icon-button"
              type="button"
              disabled={!canUndo}
              onClick={() => runHistory(undo)}
              title="Undo"
              aria-label="Undo"
            >
              <Undo2 size={17} />
            </button>
            <button
              className="icon-button"
              type="button"
              disabled={!canRedo}
              onClick={() => runHistory(redo)}
              title="Redo"
              aria-label="Redo"
            >
              <Redo2 size={17} />
            </button>
          </div>
        </header>

        <Notice notice={notice} onDismiss={() => setNotice(null)} />

        <main className={graphRoute ? "content content-graph" : "content"}>
          {loading ? <div className="loading-panel">Opening workspace…</div> : children}
        </main>
      </section>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <NavigationLinks mobile pathname={location.pathname} />
      </nav>
      <MobileGestureMenu open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen} />
    </div>
  );
}
