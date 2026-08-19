import { CircleAlert } from "lucide-react";
import { Link, Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import ActorManager from "./components/ActorManager";
import AgentHub from "./components/AgentHub";
import { AgentBubble, AgentSystemProvider } from "./components/AgentSystem";
import DatasetsPage from "./components/DatasetsPage";
import DocumentEditor from "./components/DocumentEditor";
import { DocumentPage, DocumentsPage } from "./components/Documents";
import GraphLayoutControl from "./components/GraphLayoutControl";
import GraphPage from "./components/GraphPage";
import GraphWorkspaceChrome from "./components/GraphWorkspaceChrome";
import { ImportPage } from "./components/ImportSettings";
import SettingsWorkspace from "./components/SettingsWorkspace";
import StatsPage from "./components/StatsPage";
import QuasarShell from "./ui-core/QuasarShell";

function DocumentsRoute() {
  const [params] = useSearchParams();
  if (params.get("group") === "dataset") return <Navigate to="/datasets" replace />;
  return <DocumentsPage />;
}

function GraphWorkspace() {
  return (
    <div className="graph-workspace-host">
      <GraphPage />
      <GraphWorkspaceChrome />
      <GraphLayoutControl />
    </div>
  );
}

function NotFound() {
  return (
    <section className="empty-state page-card">
      <CircleAlert size={30} />
      <h1>Route not found</h1>
      <p>The workspace route does not exist.</p>
      <Link className="button primary" to="/">Open dashboard</Link>
    </section>
  );
}

export default function App() {
  return (
    <AgentSystemProvider>
      <QuasarShell>
        <Routes>
          <Route path="/" element={<StatsPage />} />
          <Route path="/graph" element={<GraphWorkspace />} />
          <Route path="/datasets" element={<DatasetsPage />} />
          <Route path="/documents" element={<DocumentsRoute />} />
          <Route path="/documents/new" element={<DocumentEditor mode="create" />} />
          <Route path="/documents/:id" element={<DocumentPage />} />
          <Route path="/documents/:id/edit" element={<DocumentEditor mode="edit" />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/agents" element={<AgentHub />} />
          <Route path="/actors" element={<ActorManager />} />
          <Route path="/stats" element={<Navigate to="/" replace />} />
          <Route path="/settings" element={<SettingsWorkspace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <AgentBubble />
      </QuasarShell>
    </AgentSystemProvider>
  );
}
