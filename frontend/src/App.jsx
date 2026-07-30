import { useEffect, useState } from "react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Database,
  Download,
  FilePlus2,
  Filter,
  FolderInput,
  House,
  Layers3,
  Menu,
  Network,
  Plus,
  Redo2,
  Search,
  Settings,
  Sparkles,
  TableProperties,
  Undo2,
  UserRound
} from "lucide-react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQuasar } from "./store";
import GraphPage from "./components/GraphPage";
import GraphLayoutControl from "./components/GraphLayoutControl";
import GraphWorkspaceChrome from "./components/GraphWorkspaceChrome";
import { DocumentPage, DocumentsPage } from "./components/Documents";
import DocumentEditor from "./components/DocumentEditor";
import { ImportPage, SettingsPage } from "./components/ImportSettings";
import StatsPage from "./components/StatsPage";
import { AgentBubble, AgentSystemProvider } from "./components/AgentSystem";
import AgentHub from "./components/AgentHub";
import MobileGestureMenu from "./components/MobileGestureMenu";

const navigation = [
  { to: "/", label: "Home", mobileLabel: "Home", Icon: House, end: true },
  { to: "/graph", label: "Graphs", mobileLabel: "Graph", Icon: Network },
  { to: "/documents?group=dataset", label: "Datasets", Icon: Layers3 },
  { to: "/documents", label: "Documents", mobileLabel: "Docs", Icon: TableProperties, end: true },
  { to: "/documents/new", label: "Add document", mobileLabel: "Add", Icon: FilePlus2 },
  { to: "/agents", label: "Agents", Icon: Bot },
  { to: "/import", label: "Import", Icon: FolderInput },
  { to: "/settings", label: "Settings", mobileLabel: "Settings", Icon: Settings }
];

const mobileNavigation = navigation.filter(({ mobileLabel }) => mobileLabel);

function loadSidebarCollapsed() {
  try {
    return globalThis.localStorage?.getItem("quasar:sidebar-collapsed") === "1";
  } catch {
    return false;
  }
}

function SyncBadge() {
  const { syncStatus, serverStatus, queueStatus } = useQuasar();
  return (
    <div className="connection-badges">
      <span
        className={`sync-badge sync-${syncStatus.state}`}
        title={`CouchDB: ${syncStatus.message}`}
      >
        db {syncStatus.state}
      </span>
      {serverStatus.state !== "offline" && (
        <span className={`sync-badge sync-${serverStatus.state}`} title={serverStatus.message}>
          api {serverStatus.state}
        </span>
      )}
      {queueStatus.state !== "offline" && (
        <span className={`sync-badge sync-${queueStatus.state}`} title={queueStatus.message}>
          queue {queueStatus.state}
        </span>
      )}
    </div>
  );
}

function InstallButton() {
  const [installPrompt, setInstallPrompt] = useState(null);

  useEffect(() => {
    function captureInstallPrompt(event) {
      event.preventDefault();
      setInstallPrompt(event);
    }
    function clearInstallPrompt() {
      setInstallPrompt(null);
    }
    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", clearInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", clearInstallPrompt);
    };
  }, []);

  if (!installPrompt) return null;

  async function install() {
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  return (
    <button
      className="button install-button"
      type="button"
      onClick={install}
      title="Install Quasar"
    >
      <Download size={17} />
      <span>Install</span>
    </button>
  );
}

function NavigationLinks({ mobile = false }) {
  const links = mobile ? mobileNavigation : navigation;
  return links.map(({ to, label, mobileLabel, Icon, end }) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
    >
      <Icon size={mobile ? 21 : 18} aria-hidden="true" />
      <span>{mobile ? mobileLabel : label}</span>
    </NavLink>
  ));
}

function SidebarGraphs({ graphs, activeGraph, switchGraph, createGraph }) {
  function addGraph() {
    const name = window.prompt("Graph name", "Untitled graph");
    if (!name?.trim()) return;
    createGraph(name.trim());
  }

  return (
    <>
      <div className="sidebar-section-label">Workspace</div>
      <button className="workspace-selector" type="button">
        <Database size={15} />
        <span>OSINT Workspace</span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      <div className="sidebar-section-label">Graphs</div>
      <div className="sidebar-graph-list" aria-label="Workspace graphs">
        {graphs.map((graph) => (
          <div
            key={graph.id}
            className={
              graph.id === activeGraph?.id ? "sidebar-graph-row active" : "sidebar-graph-row"
            }
          >
            <button type="button" onClick={() => switchGraph(graph.id)} title={graph.name}>
              {graph.name}
            </button>
            {graph.id === activeGraph?.id && <span aria-label="Current graph">•</span>}
          </div>
        ))}
      </div>
      <button className="button small sidebar-new-graph" type="button" onClick={addGraph}>
        <Plus size={14} /> <span>New graph</span>
      </button>
    </>
  );
}

function WorkbenchShell({ children }) {
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
  const graphRoute = location.pathname === "/graph";

  function submitSearch(event) {
    event.preventDefault();
    navigate(`/documents?q=${encodeURIComponent(query)}`);
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        globalThis.localStorage?.setItem("quasar:sidebar-collapsed", next ? "1" : "0");
      } catch {
        // Storage is optional; the shell still works without persistence.
      }
      return next;
    });
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">✦</div>
          <div>
            <strong>Quasar</strong>
            <span>StarIntel workspace</span>
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
          <NavigationLinks />
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
          <div>
            <Database size={15} /> {documents.length} documents
          </div>
          <div>
            <SyncBadge />
          </div>
          <small>Offline-first · v0.9.0</small>
          <div className="sidebar-user">
            <UserRound size={18} />
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
            <Menu size={21} aria-hidden="true" />
          </button>
          <form className="global-search" onSubmit={submitSearch} role="search">
            <Search size={17} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search workspace"
              placeholder="Search everything…"
            />
          </form>
          <div className="top-actions">
            <SyncBadge />
            <InstallButton />
            <NavLink className="button graph-agent-top-action" to="/agents?tab=run">
              <Sparkles size={16} /> AI Agent
            </NavLink>
            <NavLink
              className="icon-button"
              to="/documents/new"
              title="Create document"
              aria-label="Create document"
            >
              <Plus size={18} />
            </NavLink>
            <button className="icon-button" type="button" title="Filter" aria-label="Filter">
              <Filter size={17} />
            </button>
            <button className="icon-button" type="button" title="Help" aria-label="Help">
              <CircleHelp size={17} />
            </button>
            <button
              className="icon-button"
              disabled={!canUndo}
              onClick={() =>
                undo().catch((error) => setNotice({ kind: "error", message: error.message }))
              }
              title="Undo"
              aria-label="Undo"
            >
              <Undo2 size={18} />
            </button>
            <button
              className="icon-button"
              disabled={!canRedo}
              onClick={() =>
                redo().catch((error) => setNotice({ kind: "error", message: error.message }))
              }
              title="Redo"
              aria-label="Redo"
            >
              <Redo2 size={18} />
            </button>
          </div>
        </header>

        {notice && (
          <div className={`notice notice-${notice.kind || "info"}`} role="status">
            <span>{notice.message}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss notification">
              ×
            </button>
          </div>
        )}

        <main className="content">
          {loading ? <div className="loading-panel">Opening local workspace…</div> : children}
          <GraphWorkspaceChrome />
        </main>
      </section>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <NavigationLinks mobile />
      </nav>
      <MobileGestureMenu open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen} />
    </div>
  );
}

function NotFound() {
  return (
    <section className="empty-state">
      <CircleAlert size={32} />
      <h1>Route not found</h1>
      <NavLink className="button primary" to="/">
        Open dashboard
      </NavLink>
    </section>
  );
}

export default function App() {
  return (
    <AgentSystemProvider>
      <WorkbenchShell>
        <Routes>
          <Route path="/" element={<StatsPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/new" element={<DocumentEditor mode="create" />} />
          <Route path="/documents/:id" element={<DocumentPage />} />
          <Route path="/documents/:id/edit" element={<DocumentEditor mode="edit" />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/agents" element={<AgentHub />} />
          <Route path="/stats" element={<Navigate to="/" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <GraphLayoutControl />
        <AgentBubble />
      </WorkbenchShell>
    </AgentSystemProvider>
  );
}
