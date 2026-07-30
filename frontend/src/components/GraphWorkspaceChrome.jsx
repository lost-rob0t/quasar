import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CircleDot,
  ExternalLink,
  Filter,
  Maximize2,
  MessageSquareCode,
  Minimize2,
  Play,
  Plus,
  SquareTerminal,
  TriangleAlert
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useQuasar } from "../store";
import { useAgentSystem } from "./AgentSystem";

const DOCK_TABS = [
  { id: "agent", label: "AI Agent", Icon: Bot },
  { id: "console", label: "Console", Icon: SquareTerminal },
  { id: "activity", label: "Activity", Icon: Activity },
  { id: "issues", label: "Issues", Icon: TriangleAlert }
];

function documentTimestamp(document) {
  const value =
    document?.date_updated || document?.updatedAt || document?.date_added || document?.createdAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function relativeTime(timestamp) {
  if (!timestamp) return "unknown";
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function documentName(document) {
  return (
    document?.title ||
    document?.name ||
    document?.data?.name ||
    document?.data?.label ||
    document?._id ||
    "Untitled document"
  );
}

function Metric({ label, value, tone = "" }) {
  return (
    <div className={`graph-workspace-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function GraphWorkspaceChrome() {
  const location = useLocation();
  const {
    documents = [],
    graphs = [],
    activeGraph,
    switchGraph,
    createGraph,
    syncStatus
  } = useQuasar();
  const agentSystem = useAgentSystem();
  const [dockTab, setDockTab] = useState("agent");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fullViewport, setFullViewport] = useState(false);

  const scope = useMemo(() => {
    if (!activeGraph || activeGraph.documentIds === null) return documents;
    const ids = new Set(activeGraph.documentIds || []);
    return documents.filter((document) => ids.has(document._id));
  }, [activeGraph, documents]);

  const metrics = useMemo(() => {
    const nodes = scope.filter((document) => document.dtype !== "relation").length;
    const edges = scope.filter((document) => document.dtype === "relation").length;
    const datasets = new Set(scope.map((document) => document.dataset).filter(Boolean)).size;
    const reviewed = scope.filter((document) => document.verification?.verified === true).length;
    const reviewedPercent = scope.length ? Math.round((reviewed / scope.length) * 100) : 0;
    const lastUpdated = scope.reduce(
      (latest, document) => Math.max(latest, documentTimestamp(document)),
      0
    );
    return { nodes, edges, datasets, reviewedPercent, lastUpdated };
  }, [scope]);

  const recentActivity = useMemo(
    () =>
      [...scope]
        .sort((left, right) => documentTimestamp(right) - documentTimestamp(left))
        .slice(0, 5),
    [scope]
  );

  useEffect(() => {
    document.body.classList.toggle("graph-viewport-full", fullViewport);
    const exit = (event) => {
      if (event.key === "Escape") setFullViewport(false);
    };
    document.addEventListener("keydown", exit);
    return () => {
      document.body.classList.remove("graph-viewport-full");
      document.removeEventListener("keydown", exit);
    };
  }, [fullViewport]);

  const unreviewedCount = scope.filter(
    (document) => document.verification?.verified !== true
  ).length;
  const activeRun = agentSystem.activeRun;
  const activeAgent = agentSystem.activeAgent;

  if (location.pathname !== "/graph") return null;

  function addGraph() {
    const name = window.prompt("Graph name", "Untitled graph");
    if (!name?.trim()) return;
    createGraph(name.trim());
  }

  async function submit(event) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setPrompt("");
    try {
      await agentSystem.command(value);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="graph-workspace-chrome" aria-label="Graph workspace controls">
      <div className="graph-workspace-top">
        <div className="graph-workspace-tabs" role="tablist" aria-label="Open graphs">
          {graphs.slice(0, 5).map((graph) => (
            <button
              key={graph.id}
              type="button"
              role="tab"
              aria-selected={graph.id === activeGraph?.id}
              className={graph.id === activeGraph?.id ? "active" : ""}
              onClick={() => switchGraph(graph.id)}
            >
              <CircleDot size={12} aria-hidden="true" />
              <span>{graph.name}</span>
            </button>
          ))}
          <button
            className="graph-tab-add"
            type="button"
            onClick={addGraph}
            aria-label="Create graph"
          >
            <Plus size={15} />
          </button>
          <button
            className="graph-viewport-toggle"
            type="button"
            aria-label={fullViewport ? "Exit full viewport" : "Enter full viewport"}
            aria-pressed={fullViewport}
            onClick={() => setFullViewport((value) => !value)}
          >
            {fullViewport ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            <span>{fullViewport ? "Exit full view" : "Full viewport"}</span>
          </button>
        </div>

        <div className="graph-workspace-metrics" aria-label="Graph statistics">
          <Metric label="Nodes" value={metrics.nodes.toLocaleString()} />
          <Metric label="Edges" value={metrics.edges.toLocaleString()} />
          <Metric label="Documents" value={scope.length.toLocaleString()} />
          <Metric label="Datasets" value={metrics.datasets.toLocaleString()} />
          <Metric label="Reviewed" value={`${metrics.reviewedPercent}%`} tone="success" />
          <Metric label="Last updated" value={relativeTime(metrics.lastUpdated)} tone="accent" />
          <Link className="graph-workspace-stats-link" to="/">
            View stats <ExternalLink size={13} />
          </Link>
        </div>
      </div>

      <section className="graph-agent-dock" data-tab={dockTab}>
        <nav className="graph-agent-tabs" aria-label="Graph workspace dock">
          {DOCK_TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={dockTab === id ? "active" : ""}
              onClick={() => setDockTab(id)}
            >
              <Icon size={14} /> {label}
              {id === "issues" && unreviewedCount > 0 && <span>{unreviewedCount}</span>}
            </button>
          ))}
        </nav>

        {dockTab === "agent" && (
          <div className="graph-agent-body">
            <aside className="graph-agent-identity">
              <div className="graph-agent-avatar">
                <Bot size={26} />
              </div>
              <div>
                <strong>{activeAgent?.name || "Agent"}</strong>
                <span className={`agent-status-${activeRun?.status || "idle"}`}>
                  {activeRun?.status || "idle"}
                </span>
              </div>
              <Link className="button small" to="/agents?tab=run">
                <MessageSquareCode size={14} /> Open chat
              </Link>
            </aside>
            <div className="graph-agent-command-area">
              <form className="graph-agent-command" onSubmit={submit}>
                <input
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={`Ask ${activeAgent?.name || "the agent"} about this graph…`}
                  aria-label="Ask the graph agent"
                  disabled={submitting}
                />
                <button
                  className="icon-button primary"
                  type="submit"
                  aria-label="Run agent command"
                  disabled={!prompt.trim() || submitting}
                >
                  <Play size={17} />
                </button>
              </form>
              <div className="graph-agent-suggestions">
                <button
                  type="button"
                  onClick={() =>
                    setPrompt("Find the strongest undocumented connections in this graph")
                  }
                >
                  Find missing connections
                </button>
                <button
                  type="button"
                  onClick={() => setPrompt("Show anomalies in the selected graph")}
                >
                  Show anomalies
                </button>
                <button
                  type="button"
                  onClick={() => setPrompt("Export the current subgraph as a new dataset")}
                >
                  Export subgraph
                </button>
                <button
                  type="button"
                  onClick={() => setPrompt("Run entity resolution on this graph")}
                >
                  Run entity resolution
                </button>
              </div>
              <footer>
                <span>Model: {activeRun?.modelId || activeAgent?.modelId || "not configured"}</span>
                <span>Cost: ${(activeRun?.usage?.costUsd || 0).toFixed(4)}</span>
                <span>Sync: {syncStatus?.state || "unknown"}</span>
              </footer>
            </div>
          </div>
        )}

        {dockTab === "console" && (
          <div className="graph-dock-message">
            <SquareTerminal size={20} />
            <div>
              <strong>Agent console</strong>
              <span>
                Open the full console for run history, provider controls, skills, and MCP servers.
              </span>
            </div>
            <Link className="button small" to="/agents?tab=run">
              Open console
            </Link>
          </div>
        )}

        {dockTab === "activity" && (
          <div className="graph-dock-list">
            {recentActivity.map((document) => (
              <Link key={document._id} to={`/documents/${encodeURIComponent(document._id)}`}>
                <Activity size={14} />
                <span>
                  <strong>{documentName(document)}</strong>
                  <small>
                    {document.dtype || "document"} · {relativeTime(documentTimestamp(document))}
                  </small>
                </span>
              </Link>
            ))}
            {!recentActivity.length && <p>No activity in this graph yet.</p>}
          </div>
        )}

        {dockTab === "issues" && (
          <div className="graph-dock-message warning">
            <TriangleAlert size={20} />
            <div>
              <strong>{unreviewedCount.toLocaleString()} records require review</strong>
              <span>
                Use the reviewed filter and inspector to validate imported or generated records.
              </span>
            </div>
          </div>
        )}
      </section>

      <aside className="graph-recent-activity">
        <header>
          <strong>Recent activity</strong>
          <button className="icon-button" type="button" aria-label="Filter activity">
            <Filter size={14} />
          </button>
        </header>
        <div>
          {recentActivity.map((document) => (
            <Link key={document._id} to={`/documents/${encodeURIComponent(document._id)}`}>
              <Activity size={14} />
              <span>
                <strong>{documentName(document)}</strong>
                <small>{relativeTime(documentTimestamp(document))}</small>
              </span>
            </Link>
          ))}
          {!recentActivity.length && <p>No recent activity.</p>}
        </div>
        <Link className="graph-activity-link" to="/documents">
          View all activity →
        </Link>
      </aside>
    </div>
  );
}
