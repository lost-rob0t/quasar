import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  BookOpen,
  Building2,
  CalendarDays,
  CircleDot,
  Clipboard,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Focus,
  FolderPlus,
  Grid2X2,
  Lightbulb,
  Link2,
  MapPin,
  MoreHorizontal,
  Network,
  Pause,
  Pencil,
  Play,
  Plus,
  RadioTower,
  RotateCcw,
  Search,
  Send,
  Server,
  Square,
  Trash2,
  TriangleAlert,
  UserRound,
  X
} from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  assertDocument,
  createDocument,
  documentLabel,
  dtypes,
  touchDocument
} from "starintel_doc/legacy";
import { walkLocalGraph, walkRemoteGraph, canonicalRemoteGraph } from "../lib/graph-fetch";
import { createGraphAdapter } from "../graph/GraphAdapter";
import { isGraphUserNavigationActive } from "../graph/user-navigation-guard";
import CascadingMenu from "./CascadingMenu";
import { actorApplicability, isBuiltinActor } from "../lib/actors";
import { toCanonicalDocument } from "../lib/canonical-document";
import { connectedDocumentIds } from "../lib/document-delete";
import { liveRowDocument } from "./Documents";
import {
  buildGraph,
  filterGraph,
  findPaths,
  importedGraphNodeIds,
  partitionDocumentsByReview
} from "../lib/graph";
import { activeGraphMembershipKey } from "../lib/graph-workspaces";
import {
  FORCE_LAYOUT_NODE_LIMIT,
  graphRenderDecision,
  safeInitialLayout
} from "../lib/graph-scale";
import { themedGraphStyle } from "../lib/graph-style";
import { clampRenderedPosition } from "../lib/graph-viewport";
import { operation } from "../lib/operations";
import {
  cloneResearchNode,
  researchNodeOutputIds,
  researchNodeScope
} from "../lib/research-node-graph";
import { isResearchNode } from "../lib/research-nodes";
import { useQuasar } from "../store";
import {
  CompactNodeEditor,
  CompactRelationEditor,
  CompactResearchNodeEditor
} from "./GraphEditors";

const QUICK_NODE_TYPES = [
  { dtype: "person", label: "Person", Icon: UserRound },
  { dtype: "org", label: "Organization", Icon: Building2 },
  { dtype: "event", label: "Event", Icon: CalendarDays },
  { dtype: "location", label: "Location", Icon: MapPin },
  { dtype: "entity", label: "Entity", Icon: CircleDot },
  { dtype: "document", label: "Document", Icon: FileText },
  { dtype: "source", label: "Source", Icon: BookOpen },
  { dtype: "concept", label: "Concept", Icon: Lightbulb },
  { dtype: "research-node", label: "Research node", Icon: Network }
];

function fitElements(cy, elements, padding, duration) {
  if (!cy || !elements?.length) return;
  cy.stop();
  cy.animate({ fit: { eles: elements, padding }, duration });
}

function GraphCanvas({
  graph,
  layout,
  selectedIds,
  onSelection,
  onMove,
  onViewport,
  onCanvasContext,
  onNodeContext,
  onEdgeContext,
  onRelationDraft,
  apiRef,
  edgeHandlesRef,
  labels
}) {
  const containerRef = useRef(null);
  const lastTap = useRef({ id: null, at: 0 });
  const syncingSelection = useRef(false);
  const callbacks = useRef({});
  const navigate = useNavigate();
  callbacks.current = {
    onSelection,
    onMove,
    onViewport,
    onCanvasContext,
    onNodeContext,
    onEdgeContext,
    onRelationDraft
  };

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const container = containerRef.current;
    const cy = createGraphAdapter({
      container,
      elements: [],
      style: themedGraphStyle(),
      minZoom: 0.05,
      maxZoom: 6,
      selectionType: "additive",
      boxSelectionEnabled: true
    });
    apiRef.current = cy;
    const eh = cy.edgehandles({
      canConnect: (sourceNode, targetNode) =>
        sourceNode.id() !== targetNode.id() &&
        !sourceNode.data("unresolved") &&
        !targetNode.data("unresolved"),
      edgeParams: (sourceNode, targetNode) => ({
        data: {
          id: `relation-preview-${sourceNode.id()}-${targetNode.id()}`,
          source: sourceNode.id(),
          target: targetNode.id()
        }
      }),
      snap: true,
      snapThreshold: 48,
      hoverDelay: 120
    });
    edgeHandlesRef.current = eh;

    let viewportTimer = null;
    const contextPosition = (event) => {
      const rendered = event.renderedPosition ||
        event.target?.renderedPosition?.() || { x: 12, y: 12 };
      const bounds = container.getBoundingClientRect();
      return {
        rendered,
        bounds: { width: bounds.width, height: bounds.height },
        position: event.position || {
          x: (rendered.x - cy.pan().x) / cy.zoom(),
          y: (rendered.y - cy.pan().y) / cy.zoom()
        }
      };
    };
    const emitSelection = () => {
      if (syncingSelection.current) return;
      callbacks.current.onSelection(cy.$("node:selected").map((node) => node.id()));
    };

    cy.on("select unselect", "node", emitSelection);
    cy.on("tap", (event) => {
      if (event.target === cy) {
        cy.$("node:selected").unselect();
        callbacks.current.onSelection([]);
        return;
      }
      if (!event.target.isNode()) return;
      const now = Date.now();
      const id = event.target.id();
      if (
        lastTap.current.id === id &&
        now - lastTap.current.at < 330 &&
        !event.target.data("unresolved")
      ) {
        navigate(`/documents/${encodeURIComponent(id)}`);
      }
      lastTap.current = { id, at: now };
    });
    cy.on("dragfree", "node", (event) => {
      const bounds = container.getBoundingClientRect();
      const rendered = clampRenderedPosition(
        event.target.renderedPosition(),
        bounds.width,
        bounds.height
      );
      event.target.renderedPosition(rendered);
      callbacks.current.onMove(event.target.id(), event.target.position());
    });
    cy.on("pan zoom", () => {
      clearTimeout(viewportTimer);
      viewportTimer = setTimeout(() => {
        const activeNode = cy.$("node:selected").first();
        if (activeNode.length) {
          const bounds = container.getBoundingClientRect();
          const rendered = activeNode.renderedPosition();
          const clamped = clampRenderedPosition(rendered, bounds.width, bounds.height);
          if (
            !isGraphUserNavigationActive(cy) &&
            (clamped.x !== rendered.x || clamped.y !== rendered.y)
          ) {
            cy.panBy({ x: clamped.x - rendered.x, y: clamped.y - rendered.y });
          }
        }
        callbacks.current.onViewport({ pan: cy.pan(), zoom: cy.zoom() });
      }, 140);
    });
    cy.on("cxttap", (event) => {
      const context = contextPosition(event);
      if (event.target === cy) callbacks.current.onCanvasContext(context);
      else if (event.target.isNode()) callbacks.current.onNodeContext(event.target.id(), context);
      else if (event.target.isEdge()) callbacks.current.onEdgeContext(event.target.id(), context);
    });
    cy.on("ehcomplete", (event, sourceNode, targetNode, addedEdge) => {
      const context = contextPosition(event);
      addedEdge.remove();
      callbacks.current.onRelationDraft({
        ids: [sourceNode.id(), targetNode.id()],
        rendered: context.rendered,
        bounds: context.bounds
      });
    });

    return () => {
      clearTimeout(viewportTimer);
      eh.destroy();
      edgeHandlesRef.current = null;
      apiRef.current = null;
      cy.destroy();
    };
  }, [apiRef, edgeHandlesRef, navigate]);

  useEffect(() => {
    const applyGraphTheme = () => apiRef.current?.style().fromJson(themedGraphStyle()).update();
    window.addEventListener("starintel:themechange", applyGraphTheme);
    return () => window.removeEventListener("starintel:themechange", applyGraphTheme);
  }, [apiRef]);

  useEffect(() => {
    const cy = apiRef.current;
    if (!cy) return;
    const previous = new Map(cy.nodes().map((node) => [node.id(), node.position()]));
    cy.batch(() => {
      cy.elements().remove();
      cy.add(graph.elements);
      cy.nodes().forEach((node) => {
        const position =
          graph.nodes.find((item) => item.data.id === node.id())?.position ||
          previous.get(node.id());
        if (position) node.position(position);
      });
    });
    if (graph.nodes.length && !graph.nodes.some((node) => node.position)) {
      const initialLayout = safeInitialLayout(layout, graph.nodes.length);
      cy.layout({
        name: initialLayout,
        animate: false,
        padding: 50,
        randomize: initialLayout === "cose"
      }).run();
    }
  }, [apiRef, graph, layout]);

  useEffect(() => {
    const cy = apiRef.current;
    if (!cy) return;
    const selected = new Set(selectedIds);
    syncingSelection.current = true;
    try {
      cy.nodes().forEach((node) => {
        if (selected.has(node.id()) && !node.selected()) node.select();
        if (!selected.has(node.id()) && node.selected()) node.unselect();
      });
    } finally {
      syncingSelection.current = false;
    }
  }, [apiRef, selectedIds]);

  useEffect(() => {
    const cy = apiRef.current;
    if (!cy) return;
    if (labels) cy.elements().removeClass("labels-hidden");
    else cy.elements().addClass("labels-hidden");
  }, [apiRef, labels]);

  return (
    <div
      className="graph-canvas"
      ref={containerRef}
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}

function Modal({ title, children, onClose, className = "" }) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className={`modal ${className}`}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function GraphList({ graphs, activeGraph, onSwitch, onCreate, onRename, onDelete }) {
  const activeDocumentCount = activeGraph?.documentIds?.length || 0;
  return (
    <aside className="graph-list-panel" aria-label="Graphs">
      <header>
        <span>Graphs</span>
        <button
          className="icon-button"
          type="button"
          title="Add graph from list"
          aria-label="Add graph from list"
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
      </header>
      <div
        className={`graph-list-mobile${Array.isArray(activeGraph?.documentIds) ? " deletable" : ""}`}
      >
        <label>
          <span className="sr-only">Open graph</span>
          <Network size={16} aria-hidden="true" />
          <select
            aria-label="Open graph"
            value={activeGraph?.id || ""}
            onChange={(event) => onSwitch(event.target.value)}
          >
            {(graphs || []).map((graphView) => {
              const documentCount = graphView.documentIds?.length || 0;
              const count =
                graphView.documentIds === null
                  ? "entire corpus"
                  : `${documentCount.toLocaleString()} doc${documentCount === 1 ? "" : "s"}`;
              return (
                <option key={graphView.id} value={graphView.id}>
                  {graphView.name} — {count}
                </option>
              );
            })}
          </select>
        </label>
        <button
          type="button"
          className="icon-button"
          title="Rename graph"
          aria-label="Rename graph"
          onClick={onRename}
        >
          <Pencil size={15} />
        </button>
        {Array.isArray(activeGraph?.documentIds) && (
          <button
            type="button"
            className="icon-button danger"
            title="Delete graph"
            aria-label="Delete graph"
            onClick={onDelete}
          >
            <Trash2 size={15} />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          title="New graph"
          aria-label="New graph"
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
        <small>
          {activeGraph?.documentIds === null
            ? "Entire corpus"
            : `${activeDocumentCount.toLocaleString()} document${activeDocumentCount === 1 ? "" : "s"}`}
        </small>
      </div>
      <div className="graph-list">
        {(graphs || []).map((graphView) => {
          const active = graphView.id === activeGraph?.id;
          const documentCount = graphView.documentIds?.length || 0;
          return (
            <div
              className={active ? "graph-list-item active" : "graph-list-item"}
              key={graphView.id}
            >
              <button
                className="graph-list-open"
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onSwitch(graphView.id)}
              >
                <Network size={15} />
                <span>
                  <strong>{graphView.name}</strong>
                  <small>
                    {graphView.documentIds === null
                      ? "Entire corpus"
                      : `${documentCount.toLocaleString()} document${documentCount === 1 ? "" : "s"}`}
                  </small>
                </span>
              </button>
              {active && (
                <div className="graph-list-actions">
                  <button
                    type="button"
                    title="Rename graph"
                    aria-label="Rename graph"
                    onClick={onRename}
                  >
                    <Pencil size={13} />
                  </button>
                  {graphView.documentIds !== null && (
                    <button
                      type="button"
                      className="danger"
                      title="Delete graph"
                      aria-label="Delete graph"
                      onClick={onDelete}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button className="button small full graph-create-button" type="button" onClick={onCreate}>
        <Plus size={14} /> New graph
      </button>
    </aside>
  );
}

function GraphCreate({ onClose, onCreate }) {
  const [name, setName] = useState("");
  function submit(event) {
    event.preventDefault();
    if (onCreate(name) !== false) onClose();
  }
  return (
    <Modal title="Create graph" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label className="field">
          <span>Graph name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            required
          />
        </label>
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary">Create graph</button>
        </div>
      </form>
    </Modal>
  );
}

function GraphMembershipAdd({
  documents,
  existingIds,
  onAdd,
  onClose,
  cpClient,
  serverUrl,
  serverToken,
  executeBatch,
  setNotice
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState([]);
  const [savingServer, setSavingServer] = useState(false);
  const [serverRows, setServerRows] = useState([]);
  const [serverLoading, setServerLoading] = useState(false);
  const [selectedServer, setSelectedServer] = useState({});
  const existing = useMemo(() => new Set(existingIds || []), [existingIds]);
  const corpusIds = useMemo(() => new Set(documents.map((document) => document._id)), [documents]);
  const visible = useMemo(
    () =>
      documents
        .filter((document) => document.dtype !== "relation" && !existing.has(document._id))
        .filter((document) => {
          const needle = query.trim().toLowerCase();
          if (!needle) return true;
          return `${document._id} ${document.title || ""} ${JSON.stringify(document.data || {})}`
            .toLowerCase()
            .includes(needle);
        })
        .slice(0, 100),
    [documents, existing, query]
  );

  // Server matches for the query (forgejo #142): one bounded search per
  // debounced query, filtered to records the workspace does not hold. Best
  // effort — the picker stays usable when the server is unreachable.
  useEffect(() => {
    if (!cpClient?.starintelSearch || !serverUrl) return undefined;
    const needle = query.trim();
    if (!needle) {
      setServerRows([]);
      return undefined;
    }
    let active = true;
    const timer = setTimeout(async () => {
      setServerLoading(true);
      try {
        const response = await cpClient.starintelSearch({
          url: serverUrl,
          token: serverToken || undefined,
          q: needle,
          limit: 25
        });
        if (!active) return;
        setServerRows(
          (response?.rows || [])
            .map((row) => ({
              id: row?.id,
              document: liveRowDocument(row),
              raw: row?.doc || null
            }))
            .filter((row) => row.id && !corpusIds.has(row.id) && !existing.has(row.id))
        );
      } catch {
        if (active) setServerRows([]);
      } finally {
        if (active) setServerLoading(false);
      }
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpClient, serverUrl, serverToken, query, corpusIds, existing]);

  function toggle(id) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );
  }
  function toggleServer(row) {
    setSelectedServer((current) => {
      const next = { ...current };
      if (next[row.id]) delete next[row.id];
      else next[row.id] = row.raw;
      return next;
    });
  }
  async function submit(event) {
    event.preventDefault();
    const serverIds = Object.keys(selectedServer);
    try {
      // Selecting a server record saves a local copy first; the graph can
      // only reference workspace documents.
      for (const id of serverIds) {
        const raw = selectedServer[id];
        if (!raw) continue;
        const canonical = toCanonicalDocument(raw, {
          allowLegacy090: true,
          preserveUnmapped: true
        });
        await executeBatch([canonical], "Save server document", { replace: true });
      }
      onAdd([...selected, ...serverIds]);
      onClose();
    } catch (cause) {
      setNotice({ kind: "error", message: cause?.message || "Could not save server document(s)." });
    }
  }
  const serverSelectedCount = Object.keys(selectedServer).length;
  const totalCount = selected.length + serverSelectedCount;
  return (
    <Modal title="Add corpus documents" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label className="field">
          <span>Search corpus</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
            placeholder="Name, ID, or field value"
          />
        </label>
        <div className="membership-list">
          {visible.map((document) => (
            <label key={document._id}>
              <input
                type="checkbox"
                checked={selected.includes(document._id)}
                onChange={() => toggle(document._id)}
              />
              <span>
                <strong>{documentLabel(document)}</strong>
                <code>{document._id}</code>
              </span>
            </label>
          ))}
          {!visible.length && !serverRows.length && !serverLoading && (
            <p className="muted">No available corpus documents match.</p>
          )}
          {serverRows.length > 0 && (
            <p className="muted membership-server-divider">
              On the server — selecting saves a local copy first
            </p>
          )}
          {serverRows.map((row) => (
            <label key={row.id}>
              <input
                type="checkbox"
                checked={Boolean(selectedServer[row.id])}
                onChange={() => toggleServer(row)}
              />
              <span>
                <strong>{documentLabel(row.document)}</strong>
                <code>{row.id}</code>
              </span>
            </label>
          ))}
          {serverLoading && <p className="muted">Searching the server…</p>}
        </div>
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={!totalCount || savingServer}>
            Add {totalCount || ""} document{totalCount === 1 ? "" : "s"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TargetSubmit({ document, onClose }) {
  const { settings, submitTarget, runTargetActors, setNotice } = useQuasar();
  const [actor, setActor] = useState("");
  const [target, setTarget] = useState(document._id);
  const [dataset, setDataset] = useState(document.dataset || "default");
  const [recurring, setRecurring] = useState(false);
  const [delay, setDelay] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const targetDocument = assertDocument(
        createDocument("target", {
          dataset,
          title: `Target ${documentLabel(document)}`,
          data: {
            actor,
            target,
            target_id: document._id,
            target_type: document.dtype,
            recurring,
            delay: Number(delay) || 0,
            options: []
          }
        })
      );
      await submitTarget(targetDocument, settings);
      await runTargetActors(targetDocument);
      setNotice({ kind: "success", message: `Submitted ${documentLabel(document)} to ${actor}` });
      onClose();
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Submit target" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label className="field">
          <span>Actor ID</span>
          <input
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span>Target</span>
          <input value={target} onChange={(event) => setTarget(event.target.value)} required />
        </label>
        <label className="field">
          <span>Dataset</span>
          <input value={dataset} onChange={(event) => setDataset(event.target.value)} required />
        </label>
        <label className="field">
          <span>Delay in seconds</span>
          <input
            type="number"
            min="0"
            value={delay}
            onChange={(event) => setDelay(event.target.value)}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={recurring}
            onChange={(event) => setRecurring(event.target.checked)}
          />{" "}
          Recurring target
        </label>
        {!settings?.serverUrl && (
          <p className="validation-error">Configure a StarIntel server URL in Settings first.</p>
        )}
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={submitting || !settings?.serverUrl}>
            <Send size={15} /> {submitting ? "Submitting…" : "Submit target"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function relationEndpoints(relation) {
  return [
    relation?.data?.subject || relation?.data?.source || "",
    relation?.data?.object || relation?.data?.target || ""
  ];
}

export default function GraphPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const {
    documents,
    workspace,
    selectedIds,
    selectedDocuments,
    select,
    persistWorkspace,
    actors,
    runActor,
    settings,
    setNotice,
    graphs,
    activeGraph,
    addDocumentsToActiveGraph,
    removeDocumentsFromActiveGraph,
    createGraph,
    switchGraph,
    renameGraph,
    deleteGraph,
    clearGraph,
    execute,
    executeBatch,
    cpClient,
    queueStatus,
    startQueue,
    stopQueue,
    researchRunState = {},
    runResearchNode,
    pauseResearchNode,
    resumeResearchNode,
    retryResearchNode,
    killResearchNode
  } = useQuasar();
  const apiRef = useRef(null);
  const edgeHandlesRef = useRef(null);
  const importMembershipHandled = useRef(false);
  const importFocusHandled = useRef(false);
  const importedIds = useMemo(
    () =>
      ["local-import", "search-results"].includes(location.state?.source)
        ? [...new Set(location.state.importedIds || [])]
        : [],
    [location.state]
  );
  const [query, setQuery] = useState("");
  const [dtype, setDtype] = useState("");
  const datasetParam = params.get("dataset") || "";
  const graphParam = params.get("graph") || "";
  const [dataset, setDataset] = useState(datasetParam);
  const [predicate, setPredicate] = useState("");
  const [reviewStatus, setReviewStatus] = useState(
    location.state?.revealUnreviewed || params.get("review") === "all" || !documents.length
      ? "all"
      : "reviewed"
  );
  const [labels, setLabels] = useState(true);
  const [relationDraft, setRelationDraft] = useState(null);
  const [relationEdit, setRelationEdit] = useState(null);
  const [nodeDraft, setNodeDraft] = useState(null);
  const [quickEdit, setQuickEdit] = useState(null);
  const [researchDraft, setResearchDraft] = useState(null);
  const [targetDocument, setTargetDocument] = useState(null);
  const [showGraphCreate, setShowGraphCreate] = useState(false);
  const [showMembershipAdd, setShowMembershipAdd] = useState(false);
  const [canvasMenu, setCanvasMenu] = useState(null);
  const [emptyStateDismissed, setEmptyStateDismissed] = useState(false);
  const [pathStart, setPathStart] = useState("");
  const [pathEnd, setPathEnd] = useState("");
  const [paths, setPaths] = useState([]);
  const [activePath, setActivePath] = useState(-1);
  const [runningActorId, setRunningActorId] = useState("");
  const [lastActorRun, setLastActorRun] = useState(null);

  const membershipKey = activeGraphMembershipKey(workspace || {});
  const scopedDocuments = useMemo(() => {
    if (membershipKey === "*") return documents;
    const allowed = new Set(JSON.parse(membershipKey));
    return documents.filter((document) => allowed.has(document._id));
  }, [documents, membershipKey]);
  const datasetDocuments = useMemo(
    () =>
      dataset
        ? scopedDocuments.filter((document) => document.dataset === dataset)
        : scopedDocuments,
    [dataset, scopedDocuments]
  );
  const reviewGroups = useMemo(
    () => partitionDocumentsByReview(datasetDocuments),
    [datasetDocuments]
  );
  const renderDocuments = reviewStatus === "all" ? datasetDocuments : reviewGroups.reviewed;
  const renderDecision = useMemo(() => graphRenderDecision(renderDocuments), [renderDocuments]);
  const graph = useMemo(
    () =>
      renderDecision.allowed
        ? buildGraph(renderDocuments, workspace?.positions || {})
        : { nodes: [], edges: [], elements: [] },
    [renderDecision.allowed, renderDocuments, workspace?.positions]
  );
  const visibleGraph = useMemo(
    () => filterGraph(graph, { query, dtype, predicate }),
    [graph, query, dtype, predicate]
  );
  const datasets = useMemo(
    () => [...new Set(scopedDocuments.map((document) => document.dataset || "unknown"))].sort(),
    [scopedDocuments]
  );
  const predicates = useMemo(
    () => [...new Set(graph.edges.map((edge) => edge.data.predicate).filter(Boolean))].sort(),
    [graph.edges]
  );
  const activeFilterLabels = [
    query && `search “${query}”`,
    dataset && `dataset “${dataset}”`,
    dtype && `type “${dtype}”`,
    predicate && `predicate “${predicate}”`
  ].filter(Boolean);
  const graphDocumentIds = useMemo(
    () => new Set(graph.nodes.map((node) => node.data.id)),
    [graph.nodes]
  );
  const importedFocusIds = useMemo(
    () => importedGraphNodeIds(graph, importedIds),
    [graph, importedIds]
  );
  const nodeOptions = graph.nodes
    .filter((node) => !node.data.unresolved)
    .slice()
    .sort((left, right) => left.data.label.localeCompare(right.data.label));
  const selected = selectedDocuments.find((document) => graphDocumentIds.has(document._id));
  const actorEntries = useMemo(
    () =>
      actors.map((actor) => ({
        actor,
        builtin: isBuiltinActor(actor),
        availability: actorApplicability(actor, selectedDocuments)
      })),
    [actors, selectedDocuments]
  );

  const onMove = useMemo(
    () => (id, position) => {
      persistWorkspace({ positions: { ...(workspace?.positions || {}), [id]: position } });
    },
    [persistWorkspace, workspace?.positions]
  );
  const onViewport = useMemo(
    () => (viewport) => persistWorkspace({ viewport }),
    [persistWorkspace]
  );
  const onSelection = useMemo(() => (ids) => select(ids), [select]);

  useEffect(() => {
    setDataset(datasetParam);
  }, [datasetParam]);

  useEffect(() => {
    if (
      !graphParam ||
      activeGraph?.id === graphParam ||
      !graphs?.some((candidate) => candidate.id === graphParam)
    )
      return;
    switchGraph?.(graphParam);
  }, [activeGraph?.id, graphParam, graphs, switchGraph]);

  useEffect(() => {
    setCanvasMenu(null);
    setRelationDraft(null);
    setRelationEdit(null);
    setNodeDraft(null);
    setQuickEdit(null);
    setResearchDraft(null);
    setTargetDocument(null);
    setMenuQuery("");
    setEmptyStateDismissed(false);
  }, [activeGraph?.id]);

  useEffect(() => {
    if (!canvasMenu) return undefined;
    const close = (event) => {
      if (event.key === "Escape") setCanvasMenu(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [canvasMenu]);

  useEffect(() => {
    const retained = selectedIds.filter((id) => graphDocumentIds.has(id));
    if (retained.length !== selectedIds.length) select(retained);
  }, [graphDocumentIds, select, selectedIds]);

  useEffect(() => {
    if (importMembershipHandled.current || !importedIds.length) return;
    importMembershipHandled.current = true;
    addDocumentsToActiveGraph(importedIds);
    setReviewStatus("all");
  }, [addDocumentsToActiveGraph, importedIds]);

  useEffect(() => {
    if (importFocusHandled.current || !importedFocusIds.length) return undefined;
    importFocusHandled.current = true;
    select(importedFocusIds);
    const timer = setTimeout(() => {
      const cy = apiRef.current;
      if (!cy) return;
      const elements = cy.collection();
      importedFocusIds.forEach((id) => elements.merge(cy.getElementById(id)));
      fitElements(cy, elements, 140, 350);
    }, 100);
    return () => clearTimeout(timer);
  }, [importedFocusIds, select]);

  useEffect(() => {
    const node = params.get("node");
    const document = documents.find((item) => item._id === node);
    if (!node || !document) return;
    if (!graphDocumentIds.has(node) && reviewStatus === "reviewed") {
      setReviewStatus("all");
      return;
    }
    select([node]);
    const timer = setTimeout(() => {
      const cy = apiRef.current;
      const element = cy?.getElementById(node);
      fitElements(cy, element, 160, 350);
    }, 100);
    return () => clearTimeout(timer);
  }, [documents, graphDocumentIds, params, reviewStatus, select]);

  function fit() {
    const cy = apiRef.current;
    fitElements(cy, cy?.elements(), 60, 280);
  }

  function runLayout(name) {
    const cy = apiRef.current;
    if (!cy) return;
    if (name === "cose" && graph.nodes.length > FORCE_LAYOUT_NODE_LIMIT) {
      setNotice({
        kind: "error",
        message: `Force layout is limited to ${FORCE_LAYOUT_NODE_LIMIT.toLocaleString()} nodes. Use Grid, Circle, or Concentric for this graph.`
      });
      return;
    }
    persistWorkspace({ layout: name });
    const options =
      name === "breadthfirst"
        ? { name, directed: true, padding: 60, spacingFactor: 1.25, animate: true }
        : { name, padding: 60, animate: true, randomize: name === "cose" };
    const layout = cy.layout(options);
    layout.on("layoutstop", () => {
      const positions = { ...(workspace?.positions || {}) };
      cy.nodes().forEach((node) => {
        positions[node.id()] = node.position();
      });
      persistWorkspace({ positions, layout: name });
    });
    layout.run();
  }

  function changeDataset(nextDataset) {
    setDataset(nextDataset);
    const next = new URLSearchParams(params);
    if (nextDataset) next.set("dataset", nextDataset);
    else next.delete("dataset");
    setParams(next, { replace: true });
  }

  function calculatePaths() {
    const result = findPaths(graph, pathStart, pathEnd, 7, 9);
    setPaths(result);
    applyPath(result, result.length ? 0 : -1);
  }

  function applyPath(nextPaths, index) {
    setActivePath(index);
    const cy = apiRef.current;
    if (!cy) return;
    cy.elements().removeClass("path");
    const path = nextPaths[index];
    if (!path) return;
    path.nodes.forEach((id) => cy.getElementById(id).addClass("path"));
    path.edges.forEach((edge) => cy.getElementById(edge.data.id).addClass("path"));
    fitElements(cy, cy.$(".path"), 120, 300);
  }

  function focusSelection(ids = selectedIds) {
    const cy = apiRef.current;
    if (!cy || !ids.length) return;
    if (ids !== selectedIds) select(ids);
    requestAnimationFrame(() => {
      const elements = cy.collection();
      ids.forEach((id) => elements.merge(cy.getElementById(id)));
      fitElements(cy, elements.closedNeighborhood(), 100, 300);
    });
  }

  useEffect(() => {
    const handleAgentCommand = (event) => {
      const command = event.detail || {};
      if (command.op === "fit_graph") fit();
      if (command.op === "focus_selection")
        focusSelection(command.ids?.length ? command.ids : selectedIds);
      if (command.op === "apply_layout") runLayout(command.layout || "cose");
    };
    window.addEventListener("quasar:agent-graph-command", handleAgentCommand);
    return () => window.removeEventListener("quasar:agent-graph-command", handleAgentCommand);
  });

  function clearFilters() {
    setQuery("");
    setDtype("");
    setDataset("");
    setPredicate("");
    const next = new URLSearchParams(params);
    next.delete("dataset");
    setParams(next, { replace: true });
  }

  function openQuickAdd(context = null, objectType = "entity") {
    setCanvasMenu(null);
    const draft = {
      objectType,
      dataset: selected?.dataset || dataset || "default",
      inputIds: selectedIds,
      position: context?.position ? context : null
    };
    if (objectType === "research-node") setResearchDraft(draft);
    else setNodeDraft(draft);
  }

  function openCanvasMenu(context) {
    setEmptyStateDismissed(true);
    setMenuQuery("");
    setCanvasMenu({ kind: "canvas", ...context });
  }

  function openNodeMenu(id, context) {
    if (!selectedIds.includes(id)) select([id]);
    setMenuQuery("");
    setCanvasMenu({ kind: "node", id, ...context });
  }

  function openEdgeMenu(id, context) {
    setMenuQuery("");
    setCanvasMenu({ kind: "edge", id, ...context });
  }

  function beginRelationFromNode(id) {
    const node = apiRef.current?.getElementById(id);
    setCanvasMenu(null);
    if (node?.length) edgeHandlesRef.current?.start(node);
  }

  function openSelectedRelation() {
    if (selectedIds.length !== 2) return;
    const cy = apiRef.current;
    const first = cy?.getElementById(selectedIds[0]);
    const second = cy?.getElementById(selectedIds[1]);
    const firstPosition = first?.length ? first.renderedPosition() : { x: 100, y: 100 };
    const secondPosition = second?.length ? second.renderedPosition() : firstPosition;
    const bounds = cy?.container()?.getBoundingClientRect();
    setRelationDraft({
      ids: [...selectedIds],
      rendered: {
        x: (firstPosition.x + secondPosition.x) / 2,
        y: (firstPosition.y + secondPosition.y) / 2
      },
      bounds: { width: bounds?.width || 600, height: bounds?.height || 500 }
    });
  }

  function closeCanvasMenu(event) {
    if (canvasMenu && !event.target.closest(".graph-context-menu")) setCanvasMenu(null);
  }

  function createNamedGraph(name) {
    try {
      createGraph(name);
      setReviewStatus("all");
      clearFilters();
      setPaths([]);
      setActivePath(-1);
      return true;
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
      return false;
    }
  }

  function changeGraph(id) {
    try {
      switchGraph(id);
      setReviewStatus("all");
      clearFilters();
      setPaths([]);
      setActivePath(-1);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  function renameCurrentGraph() {
    const name = window.prompt("Graph name", activeGraph?.name || "");
    if (name === null) return;
    try {
      renameGraph(name);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  function deleteCurrentGraph() {
    if (
      !window.confirm(
        `Delete graph "${activeGraph?.name || ""}"? Corpus documents will not be deleted.`
      )
    )
      return;
    try {
      deleteGraph();
      setReviewStatus("all");
      clearFilters();
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  function clearCurrentGraph() {
    const corpusView = activeGraph?.documentIds === null;
    const message = corpusView
      ? "Clear the All documents view by creating a new empty graph? Corpus documents will not be deleted."
      : `Clear graph "${activeGraph?.name || ""}"? Corpus documents will not be deleted.`;
    if (!window.confirm(message)) return;
    try {
      clearGraph();
      setReviewStatus("all");
      clearFilters();
      select([]);
      setCanvasMenu(null);
      setNotice({
        kind: "success",
        message: corpusView ? "Created a new empty graph." : "Graph cleared."
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  function addExistingDocuments(ids) {
    const members = new Set([...(activeGraph?.documentIds || []), ...ids]);
    const relationIds = documents
      .filter((document) => document.dtype === "relation")
      .filter(
        (document) => members.has(document.data?.subject) && members.has(document.data?.object)
      )
      .map((document) => document._id);
    addDocumentsToActiveGraph([...ids, ...relationIds], { selectedIds: ids });
    setReviewStatus("all");
    clearFilters();
  }

  function removeSelectionFromGraph() {
    if (!selectedIds.length || activeGraph?.documentIds === null) return;
    removeDocumentsFromActiveGraph(connectedDocumentIds(scopedDocuments, selectedIds));
  }

  function removeNodeFromGraph(id) {
    if (activeGraph?.documentIds === null) return;
    select([id]);
    removeDocumentsFromActiveGraph(connectedDocumentIds(scopedDocuments, [id]));
    setCanvasMenu(null);
  }

  function selectNeighbors(id) {
    const node = apiRef.current?.getElementById(id);
    if (!node?.length) return;
    select(
      node
        .closedNeighborhood()
        .nodes()
        .map((item) => item.id())
    );
    setCanvasMenu(null);
  }

  async function copyText(value, message) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ kind: "success", message });
      setCanvasMenu(null);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function deleteCorpusDocuments(ids) {
    const deleteIds = connectedDocumentIds(documents, ids);
    if (
      !window.confirm(
        `Delete ${deleteIds.length} corpus document(s)? This includes connected relation documents and can be undone.`
      )
    )
      return;
    try {
      await execute(
        operation.batch(
          deleteIds.map((id) => operation.remove(id)),
          "Delete graph documents"
        ),
        `Delete ${deleteIds.length} graph document(s)`
      );
      if (activeGraph?.documentIds !== null) removeDocumentsFromActiveGraph(deleteIds);
      select([]);
      setCanvasMenu(null);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function reverseRelation(relation) {
    const [source, target] = relationEndpoints(relation);
    try {
      const updated = assertDocument(
        touchDocument(relation, {
          title: `${target} ${relation.data?.predicate || "related-to"} ${source}`,
          data: { ...(relation.data || {}), subject: target, object: source }
        })
      );
      await execute(operation.save(updated), `Reverse ${relation._id}`);
      setCanvasMenu(null);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function toggleQueueListener() {
    try {
      if (queueStatus.state === "active" || queueStatus.state === "connecting") stopQueue();
      else startQueue(settings);
      setCanvasMenu(null);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function fetchGraphIntoWorkspace(rootId, mode) {
    const root = documents.find((document) => document._id === rootId);
    const label = root ? documentLabel(root) : rootId;
    try {
      if (mode.startsWith("local")) {
        if (!activeGraph) throw new Error("Select or create a graph first.");
        const depth = mode === "local-neighbors" ? 1 : 2;
        const result = walkLocalGraph(documents, rootId, { depth });
        const ids = [
          ...new Set([
            ...result.documents.map((document) => document._id),
            ...result.relations.map((document) => document._id)
          ])
        ];
        addDocumentsToActiveGraph(ids);
        setNotice({
          kind: "success",
          message: `Fetched local graph of ${label}: ${result.documents.length} documents, ${
            result.relations.length
          } relations${result.truncated ? " (budget-truncated)" : ""}.`
        });
        return;
      }
      if (!cpClient?.starintelNeighbors || !settings?.serverUrl) {
        throw new Error("Configure a StarIntel server in Settings first.");
      }
      const depth = mode === "remote-neighbors" ? 1 : mode === "remote-graph-3" ? 3 : 2;
      const result = await walkRemoteGraph(
        cpClient,
        {
          url: settings.serverUrl,
          ...(settings.serverToken ? { token: settings.serverToken } : {})
        },
        rootId,
        { depth }
      );
      const dataset = root?.dataset || "default";
      const { documents: canonical, relations: relationDocs } = canonicalRemoteGraph(
        result,
        rootId,
        dataset
      );
      const imports = [...canonical, ...relationDocs];
      if (imports.length) {
        await executeBatch(imports, `Fetch server graph: ${label}`, { replace: false });
      }
      if (activeGraph) {
        addDocumentsToActiveGraph([
          ...new Set([...result.documents.map((document) => document._id)])
        ]);
      }
      setNotice({
        kind: "success",
        message: `Fetched server graph of ${label}: ${result.documents.length} documents, ${
          result.relations.length
        } relations in ${result.requests} requests${result.truncated ? " (budget-truncated)" : ""}.`
      });
    } catch (cause) {
      setNotice({ kind: "error", message: cause?.message || "Graph fetch failed." });
    }
  }

  async function executeActor(actor, runOptions = {}) {
    setRunningActorId(actor.id);
    setLastActorRun(null);
    try {
      const result = await runActor(actor, undefined, runOptions);
      const produced = Array.isArray(result?.documents) ? result.documents : [];
      const nodeIds = produced
        .filter((document) => document?.dtype !== "relation")
        .map((document) => document._id)
        .filter(Boolean)
        .slice(0, 100);
      if (produced.length) {
        setReviewStatus("all");
        clearFilters();
        if (nodeIds.length) select(nodeIds);
      }
      setLastActorRun({
        actorId: actor.id,
        produced: produced.length,
        message: result?.message || `Actor produced ${produced.length} document(s).`
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    } finally {
      setRunningActorId("");
    }
  }

  function inspectResearchOutputs(document) {
    const outputIds = researchNodeOutputIds(document).filter((id) => graphDocumentIds.has(id));
    setCanvasMenu(null);
    if (!outputIds.length) {
      setNotice({
        kind: "info",
        message: "This research node has no outputs in the active graph."
      });
      return;
    }
    select(outputIds);
    focusSelection(outputIds);
  }

  async function cloneContextResearchNode(document) {
    try {
      const suffix = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const cloned = cloneResearchNode(document, {
        id: `starintel:research-node:${suffix}`
      });
      await execute(operation.save(cloned), `Clone ${document._id}`);
      if (activeGraph?.documentIds !== null) {
        addDocumentsToActiveGraph([cloned._id], { selectedIds: [cloned._id] });
      }
      setReviewStatus("all");
      clearFilters();
      select([cloned._id]);
      setCanvasMenu(null);
      setNotice({ kind: "success", message: `Cloned research node as ${cloned._id}` });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function executeResearchAction(action, document) {
    setCanvasMenu(null);
    const actions = {
      run: runResearchNode,
      pause: pauseResearchNode,
      resume: resumeResearchNode,
      retry: retryResearchNode,
      kill: killResearchNode
    };
    try {
      await actions[action](document);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  const contextNode =
    canvasMenu?.kind === "node"
      ? documents.find((document) => document._id === canvasMenu.id)
      : null;
  const contextRelation =
    canvasMenu?.kind === "edge"
      ? documents.find((document) => document._id === canvasMenu.id)
      : null;
  const contextResearchScope =
    contextNode && isResearchNode(contextNode) ? researchNodeScope(contextNode) : null;
  const selectedResearchScope =
    selected && isResearchNode(selected) ? researchNodeScope(selected) : null;
  const contextResearchStatus = contextNode?.data?.status || "draft";
  const contextResearchActive = ["queued", "running"].includes(
    researchRunState[contextNode?._id]?.state
  );
  const selectedResearchStatus = selected?.data?.status || "draft";
  const selectedResearchActive = ["queued", "running"].includes(
    researchRunState[selected?._id]?.state
  );
  const [contextSourceId, contextTargetId] = relationEndpoints(contextRelation);

  // Cascading right-click menu (3 levels): root path -> class -> leaf.
  // Same handlers the flat menu used; fleet actors take the node label as
  // their explicit target.
  const closeMenu = () => setCanvasMenu(null);
  const runContextActor = (actor, target) => {
    closeMenu();
    executeActor(actor, target ? { target } : undefined);
  };
  const actorClassItems = (classFilter, withTarget) =>
    actorEntries
      .filter(({ actor }) => classFilter(actor))
      .map(({ actor, availability }) => ({
        label: actor.label,
        Icon: Play,
        disabled: !availability.applicable || Boolean(runningActorId),
        title: availability.applicable ? undefined : availability.reason,
        onSelect: () => runContextActor(actor, withTarget ? documentLabel(contextNode) : undefined)
      }));
  const contextMenuItems = useMemo(() => {
    if (!canvasMenu) return [];
    if (canvasMenu.kind === "node" && contextNode) {
      const researchChildren = contextResearchScope
        ? [
            ...(!contextResearchActive &&
            ["draft", "queued", "running", "completed", "killed"].includes(contextResearchStatus)
              ? [
                  {
                    label: "Run research node",
                    Icon: Play,
                    onSelect: () => {
                      closeMenu();
                      executeResearchAction("run", contextNode);
                    }
                  }
                ]
              : []),
            ...(contextResearchActive
              ? [
                  {
                    label: "Pause research node",
                    Icon: Pause,
                    onSelect: () => {
                      closeMenu();
                      executeResearchAction("pause", contextNode);
                    }
                  }
                ]
              : []),
            ...(contextResearchStatus === "paused"
              ? [
                  {
                    label: "Resume research node",
                    Icon: Play,
                    onSelect: () => {
                      closeMenu();
                      executeResearchAction("resume", contextNode);
                    }
                  }
                ]
              : []),
            ...(["failed", "blocked"].includes(contextResearchStatus)
              ? [
                  {
                    label: "Retry research node",
                    Icon: RotateCcw,
                    onSelect: () => {
                      closeMenu();
                      executeResearchAction("retry", contextNode);
                    }
                  }
                ]
              : []),
            ...(["queued", "running", "paused", "blocked", "failed"].includes(contextResearchStatus)
              ? [
                  {
                    label: "Kill research node",
                    Icon: Square,
                    danger: true,
                    onSelect: () => {
                      closeMenu();
                      executeResearchAction("kill", contextNode);
                    }
                  }
                ]
              : []),
            {
              label: `Inspect outputs (${contextResearchScope.outputs.length})`,
              Icon: Focus,
              disabled: !contextResearchScope.outputs.length,
              onSelect: () => {
                closeMenu();
                inspectResearchOutputs(contextNode);
              }
            },
            {
              label: "Clone research node",
              Icon: Copy,
              onSelect: () => {
                closeMenu();
                cloneContextResearchNode(contextNode);
              }
            }
          ]
        : [];
      return [
        {
          label: "Edit",
          Icon: Pencil,
          onSelect: () => {
            closeMenu();
            if (isResearchNode(contextNode))
              setResearchDraft({ document: contextNode, position: canvasMenu });
            else setQuickEdit({ document: contextNode, position: canvasMenu });
          }
        },
        {
          label: "Run actor",
          Icon: Play,
          children: [
            {
              label: "Built-in",
              Icon: Layers,
              children: actorClassItems((actor) => isBuiltinActor(actor), false)
            },
            {
              label: "Local fleet",
              Icon: Server,
              children: actorClassItems((actor) => actor.runtime === "pro-actor-fleet", true)
            },
            {
              label: "Shipped pack",
              Icon: BookOpen,
              children: actorClassItems(
                (actor) => !isBuiltinActor(actor) && actor.runtime !== "pro-actor-fleet",
                false
              )
            }
          ]
        },
        ...(researchChildren.length
          ? [{ label: "Research", Icon: Network, children: researchChildren }]
          : []),
        {
          label: "Fetch graph",
          Icon: Network,
          children: [
            {
              label: "Neighbors",
              Icon: Network,
              children: [
                {
                  label: "Local",
                  Icon: Network,
                  onSelect: () => {
                    closeMenu();
                    fetchGraphIntoWorkspace(contextNode._id, "local-neighbors");
                  }
                },
                {
                  label: "Server",
                  Icon: Server,
                  onSelect: () => {
                    closeMenu();
                    fetchGraphIntoWorkspace(contextNode._id, "remote-neighbors");
                  }
                }
              ]
            },
            {
              label: "Whole graph",
              Icon: Layers,
              children: [
                {
                  label: "Local (depth 2)",
                  Icon: Network,
                  onSelect: () => {
                    closeMenu();
                    fetchGraphIntoWorkspace(contextNode._id, "local-graph");
                  }
                },
                {
                  label: "Server (depth 2)",
                  Icon: Server,
                  onSelect: () => {
                    closeMenu();
                    fetchGraphIntoWorkspace(contextNode._id, "remote-graph");
                  }
                },
                {
                  label: "Server (depth 3)",
                  Icon: Server,
                  onSelect: () => {
                    closeMenu();
                    fetchGraphIntoWorkspace(contextNode._id, "remote-graph-3");
                  }
                }
              ]
            }
          ]
        },
        {
          label: "Create",
          Icon: Plus,
          children: [
            {
              label: "Research node from selection",
              Icon: Network,
              onSelect: () => {
                closeMenu();
                setResearchDraft({
                  dataset: contextNode.dataset || "default",
                  inputIds: selectedIds.length ? selectedIds : [contextNode._id],
                  position: canvasMenu
                });
              }
            },
            ...QUICK_NODE_TYPES.map(({ dtype, label, Icon }) => ({
              label: `Create ${label.toLowerCase()}`,
              Icon,
              onSelect: () => {
                closeMenu();
                openQuickAdd(canvasMenu, dtype);
              }
            })),
            {
              label: "Other object type",
              Icon: MoreHorizontal,
              onSelect: () => {
                closeMenu();
                openQuickAdd(canvasMenu);
              }
            }
          ]
        },
        {
          label: "View",
          Icon: Focus,
          children: [
            {
              label: "Open full editor",
              Icon: ExternalLink,
              onSelect: () => {
                closeMenu();
                navigate(`/documents/${encodeURIComponent(contextNode._id)}`);
              }
            },
            {
              label: "Focus",
              Icon: Focus,
              onSelect: () => {
                closeMenu();
                focus(contextNode._id);
              }
            },
            {
              label: "Select neighbors",
              Icon: Network,
              onSelect: () => {
                closeMenu();
                selectNeighbors(contextNode._id);
              }
            }
          ]
        },
        {
          label: "Copy",
          Icon: Clipboard,
          children: [
            {
              label: "Document ID",
              Icon: Clipboard,
              onSelect: () => {
                closeMenu();
                copyText(contextNode._id, "Copied document ID");
              }
            },
            {
              label: "Document JSON",
              Icon: Braces,
              onSelect: () => {
                closeMenu();
                copyText(JSON.stringify(contextNode, null, 2), "Copied document JSON");
              }
            }
          ]
        },
        {
          label: "Submit as target",
          Icon: Send,
          onSelect: () => {
            closeMenu();
            setTargetDocument(contextNode);
          }
        },
        ...(activeGraph?.documentIds !== null
          ? [
              {
                label: "Hide",
                Icon: Trash2,
                onSelect: () => {
                  closeMenu();
                  removeNodeFromGraph(contextNode._id);
                }
              }
            ]
          : []),
        {
          label: "Delete",
          Icon: Trash2,
          danger: true,
          onSelect: () => {
            closeMenu();
            deleteCorpusDocuments(selectedIds.length > 1 ? selectedIds : [contextNode._id]);
          }
        }
      ];
    }
    if (canvasMenu.kind === "edge" && contextRelation) {
      return [
        {
          label: "Edit relation",
          Icon: Pencil,
          onSelect: () => {
            closeMenu();
            setRelationEdit({ document: contextRelation, position: canvasMenu });
          }
        },
        {
          label: "Reverse relation",
          Icon: ArrowLeftRight,
          onSelect: () => {
            closeMenu();
            reverseRelation(contextRelation);
          }
        },
        ...(contextSourceId
          ? [
              {
                label: "Open source",
                Icon: ExternalLink,
                onSelect: () => {
                  closeMenu();
                  navigate(`/documents/${encodeURIComponent(contextSourceId)}`);
                }
              }
            ]
          : []),
        ...(contextTargetId
          ? [
              {
                label: "Open target",
                Icon: ExternalLink,
                onSelect: () => {
                  closeMenu();
                  navigate(`/documents/${encodeURIComponent(contextTargetId)}`);
                }
              }
            ]
          : []),
        {
          label: "Inspect JSON",
          Icon: Copy,
          onSelect: () => {
            closeMenu();
            navigate(`/documents/${encodeURIComponent(contextRelation._id)}`);
          }
        },
        {
          label: "Delete",
          Icon: Trash2,
          danger: true,
          onSelect: () => {
            closeMenu();
            deleteCorpusDocuments([contextRelation._id]);
          }
        }
      ];
    }
    if (canvasMenu.kind === "canvas") {
      return [
        {
          label: "Create",
          Icon: Plus,
          children: [
            ...QUICK_NODE_TYPES.map(({ dtype, label, Icon }) => ({
              label: `Create ${label.toLowerCase()}`,
              Icon,
              onSelect: () => {
                closeMenu();
                openQuickAdd(canvasMenu, dtype);
              }
            })),
            {
              label: "Other object type",
              Icon: MoreHorizontal,
              onSelect: () => {
                closeMenu();
                openQuickAdd(canvasMenu);
              }
            }
          ]
        },
        {
          label: "Layout",
          Icon: Grid2X2,
          children: ["cose", "breadthfirst", "circle", "concentric", "grid"].map((name) => ({
            label: name,
            Icon: Grid2X2,
            onSelect: () => {
              closeMenu();
              runLayout(name);
            }
          }))
        },
        {
          label: "Graph",
          Icon: Database,
          children: [
            {
              label: "New graph",
              Icon: FolderPlus,
              onSelect: () => {
                closeMenu();
                setShowGraphCreate(true);
              }
            },
            ...(activeGraph?.documentIds !== null
              ? [
                  {
                    label: "Add from corpus",
                    Icon: Database,
                    onSelect: () => {
                      closeMenu();
                      setShowMembershipAdd(true);
                    }
                  }
                ]
              : []),
            {
              label: "Import documents",
              Icon: ExternalLink,
              onSelect: () => {
                closeMenu();
                navigate("/import");
              }
            }
          ]
        },
        {
          label: "Server",
          Icon: Server,
          children: [
            {
              label: `${queueStatus.state === "active" ? "Stop" : "Start"} queue listener`,
              Icon: RadioTower,
              disabled: !settings?.rabbitWebSocketUrl,
              onSelect: () => {
                closeMenu();
                toggleQueueListener();
              }
            },
            {
              label: "Connection settings",
              Icon: Server,
              onSelect: () => {
                closeMenu();
                navigate("/settings");
              }
            }
          ]
        },
        {
          label: "View",
          Icon: Focus,
          children: [
            {
              label: "Fit graph",
              Icon: Focus,
              onSelect: () => {
                closeMenu();
                fit();
              }
            },
            {
              label: "Focus selection",
              Icon: Focus,
              disabled: !selectedIds.length,
              onSelect: () => {
                closeMenu();
                focusSelection();
              }
            },
            {
              label: "Clear filters",
              Icon: X,
              onSelect: () => {
                closeMenu();
                clearFilters();
              }
            }
          ]
        },
        ...(activeGraph?.documentIds !== null
          ? [
              {
                label: "Clear graph",
                Icon: Trash2,
                danger: true,
                onSelect: () => {
                  closeMenu();
                  clearCurrentGraph();
                }
              }
            ]
          : [])
      ];
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canvasMenu,
    contextNode,
    contextRelation,
    contextResearchScope,
    contextResearchStatus,
    contextResearchActive,
    contextSourceId,
    contextTargetId,
    actorEntries,
    runningActorId,
    selectedIds,
    activeGraph,
    queueStatus,
    settings
  ]);

  return (
    <section className="graph-page">
      <Link className="back-link" to="/">
        <ArrowLeft size={14} /> Statistics dashboard
      </Link>
      <div className="page-heading graph-heading">
        <div>
          <span className="eyebrow">Investigation graph</span>
          <h1>Graph explorer</h1>
          <p>
            Search, filter, and inspect the relationship network. Reviewed records are shown by
            default.
          </p>
        </div>
        <div className="graph-heading-actions">
          <div className="graph-source-status">
            <Database size={17} />
            <span>
              <strong>Local PouchDB corpus</strong>
              <small>startup + live changes</small>
            </span>
          </div>
          <div className="graph-switcher">
            <select
              aria-label="Active graph"
              value={activeGraph?.id || ""}
              onChange={(event) => changeGraph(event.target.value)}
            >
              {(graphs || []).map((graphView) => (
                <option key={graphView.id} value={graphView.id}>
                  {graphView.name}
                  {graphView.documentIds === null
                    ? " · all documents"
                    : ` · ${graphView.documentIds.length}`}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              title="Create graph"
              aria-label="Create graph"
              onClick={() => setShowGraphCreate(true)}
            >
              <FolderPlus size={16} />
            </button>
            <button
              className="icon-button"
              title="Rename graph"
              aria-label="Rename graph"
              onClick={renameCurrentGraph}
            >
              <Pencil size={15} />
            </button>
            <button
              className="icon-button danger"
              title="Delete graph"
              aria-label="Delete graph"
              onClick={deleteCurrentGraph}
              disabled={(graphs || []).length <= 1}
            >
              <Trash2 size={15} />
            </button>
          </div>
          <div className="button-row">
            {activeGraph?.documentIds !== null && (
              <button className="button" onClick={() => setShowMembershipAdd(true)}>
                <Plus size={16} /> Add from corpus
              </button>
            )}
            {activeGraph?.documentIds !== null && (
              <button
                className="button danger"
                onClick={removeSelectionFromGraph}
                disabled={!selectedIds.length}
              >
                Remove from graph
              </button>
            )}
            <button
              className="button danger"
              onClick={() => deleteCorpusDocuments(selectedIds)}
              disabled={!selectedIds.length}
            >
              Delete selected documents
            </button>
            <button className="button" onClick={clearCurrentGraph}>
              Clear graph
            </button>
            <button
              className="button"
              onClick={openSelectedRelation}
              disabled={selectedIds.length !== 2}
            >
              <Link2 size={16} /> Connect selected
            </button>
            <button className="button primary" onClick={() => openQuickAdd()}>
              <Plus size={16} /> Add graph document
            </button>
          </div>
        </div>
      </div>

      <div className="graph-toolbar">
        <label className="graph-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search graph"
          />
        </label>
        <select
          aria-label="Dataset filter"
          value={dataset}
          onChange={(event) => changeDataset(event.target.value)}
        >
          <option value="">All datasets</option>
          {datasets.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Object type filter"
          value={dtype}
          onChange={(event) => setDtype(event.target.value)}
        >
          <option value="">All object types</option>
          {dtypes.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <select
          aria-label="Predicate filter"
          value={predicate}
          onChange={(event) => setPredicate(event.target.value)}
        >
          <option value="">All predicates</option>
          {predicates.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Reviewed status filter"
          value={reviewStatus}
          onChange={(event) => setReviewStatus(event.target.value)}
        >
          <option value="reviewed">Reviewed only</option>
          <option value="all">Reviewed + unreviewed</option>
        </select>
        <select
          aria-label="Graph layout"
          value={workspace?.layout || "cose"}
          onChange={(event) => runLayout(event.target.value)}
        >
          <option value="cose">Force</option>
          <option value="breadthfirst">Hierarchy</option>
          <option value="circle">Circle</option>
          <option value="concentric">Concentric</option>
          <option value="grid">Grid</option>
        </select>
        <button className="button small" onClick={fit}>
          Fit
        </button>
        <button
          className="button small"
          onClick={() => focusSelection()}
          disabled={!selectedIds.length}
        >
          <Focus size={15} /> Focus
        </button>
        <label className="checkbox compact">
          <input
            type="checkbox"
            checked={labels}
            onChange={(event) => setLabels(event.target.checked)}
          />{" "}
          Labels
        </label>
        <span className="graph-count">
          {visibleGraph.nodes.length} nodes · {visibleGraph.edges.length} edges ·{" "}
          {reviewGroups.reviewed.length.toLocaleString()} reviewed ·{" "}
          {reviewGroups.unreviewed.length.toLocaleString()} unreviewed
        </span>
      </div>

      {reviewStatus === "all" && reviewGroups.unreviewed.length > 0 && (
        <div className="graph-review-warning">
          <TriangleAlert size={17} />
          <span>
            {importedIds.length
              ? "Imported records are revealed for this graph session. "
              : "Unreviewed data is enabled. "}
            {reviewGroups.unreviewed.length.toLocaleString()} unreviewed records are displayed
            alongside reviewed records.
          </span>
        </div>
      )}

      <div className="graph-workbench">
        <GraphList
          graphs={graphs}
          activeGraph={activeGraph}
          onSwitch={changeGraph}
          onCreate={() => setShowGraphCreate(true)}
          onRename={renameCurrentGraph}
          onDelete={deleteCurrentGraph}
        />
        <div className="graph-stage" onPointerDown={closeCanvasMenu}>
          {renderDecision.allowed && (
            <GraphCanvas
              graph={visibleGraph}
              layout={workspace?.layout || "cose"}
              selectedIds={selectedIds}
              onSelection={onSelection}
              onMove={onMove}
              onViewport={onViewport}
              onCanvasContext={openCanvasMenu}
              onNodeContext={openNodeMenu}
              onEdgeContext={openEdgeMenu}
              onRelationDraft={setRelationDraft}
              apiRef={apiRef}
              edgeHandlesRef={edgeHandlesRef}
              labels={labels}
            />
          )}

          {!renderDecision.allowed && (
            <div className="graph-empty-state graph-load-guard" role="alert">
              <TriangleAlert size={38} />
              <h2>Graph load blocked</h2>
              <p>
                This view expands to {renderDecision.estimate.documents.toLocaleString()} documents,{" "}
                {renderDecision.estimate.nodes.toLocaleString()} nodes, and{" "}
                {renderDecision.estimate.elements.toLocaleString()} total graph elements. The safe
                cutoff is {renderDecision.limits.maxDocuments.toLocaleString()} documents,{" "}
                {renderDecision.limits.maxNodes.toLocaleString()} nodes, or{" "}
                {renderDecision.limits.maxElements.toLocaleString()} elements.
              </p>
              <p>Select a dataset above or open a smaller custom graph.</p>
              <div className="button-row">
                <Link className="button" to="/documents?group=dataset">
                  Browse datasets
                </Link>
                <button className="button primary" onClick={() => setShowGraphCreate(true)}>
                  New graph
                </button>
              </div>
            </div>
          )}

          {renderDecision.allowed && !visibleGraph.nodes.length && !emptyStateDismissed && (
            <div className="graph-empty-state">
              <Network size={38} />
              <h2>{scopedDocuments.length ? "No graph nodes match" : "Start a blank graph"}</h2>
              <p>
                {activeFilterLabels.length && scopedDocuments.length
                  ? `Hidden by ${activeFilterLabels.join(", ")}.`
                  : graph.nodes.length
                    ? "No nodes remain after applying the current graph view."
                    : reviewGroups.unreviewed.length
                      ? `${reviewGroups.unreviewed.length.toLocaleString()} unreviewed document(s) are hidden by the current review filter.`
                      : "Right-click anywhere to create the first node, or use an action below."}
              </p>
              <div className="button-row">
                {activeFilterLabels.length > 0 && scopedDocuments.length > 0 && (
                  <button className="button small" onClick={clearFilters}>
                    Show all {scopedDocuments.length.toLocaleString()} documents
                  </button>
                )}
                {!graph.nodes.length && reviewGroups.unreviewed.length > 0 && (
                  <button className="button small" onClick={() => setReviewStatus("all")}>
                    Show unreviewed
                  </button>
                )}
                {!graph.nodes.length && activeGraph?.documentIds !== null && (
                  <button className="button small" onClick={() => setShowMembershipAdd(true)}>
                    Add from corpus
                  </button>
                )}
                {!graph.nodes.length && (
                  <button className="button primary small" onClick={() => openQuickAdd()}>
                    <Plus size={15} /> Create first node
                  </button>
                )}
                {!graph.nodes.length && (
                  <Link className="button small" to="/import">
                    Import documents
                  </Link>
                )}
                <button className="button small" onClick={() => setEmptyStateDismissed(true)}>
                  Enter blank canvas
                </button>
              </div>
            </div>
          )}

          {canvasMenu && (
            <CascadingMenu
              key={`${canvasMenu.kind}:${canvasMenu.rendered?.x}:${canvasMenu.rendered?.y}`}
              x={canvasMenu.rendered?.x ?? 0}
              y={canvasMenu.rendered?.y ?? 0}
              bounds={canvasMenu.bounds}
              header={
                contextNode
                  ? documentLabel(contextNode)
                  : contextRelation
                    ? documentLabel(contextRelation)
                    : activeGraph?.name || "Graph"
              }
              items={contextMenuItems}
              onClose={() => setCanvasMenu(null)}
            />
          )}

          {nodeDraft && (
            <CompactNodeEditor
              objectType={nodeDraft.objectType}
              dataset={nodeDraft.dataset}
              position={nodeDraft.position}
              onClose={() => setNodeDraft(null)}
              onSaved={() => setReviewStatus("all")}
            />
          )}
          {quickEdit && (
            <CompactNodeEditor
              document={quickEdit.document}
              position={quickEdit.position}
              onClose={() => setQuickEdit(null)}
            />
          )}
          {researchDraft && (
            <CompactResearchNodeEditor
              document={researchDraft.document || null}
              dataset={researchDraft.dataset || "default"}
              inputIds={researchDraft.inputIds || []}
              position={researchDraft.position}
              onClose={() => setResearchDraft(null)}
              onSaved={() => setReviewStatus("all")}
            />
          )}
          {relationDraft && (
            <CompactRelationEditor
              key={relationDraft.ids.join(":")}
              ids={relationDraft.ids}
              documents={scopedDocuments}
              position={relationDraft}
              onClose={() => setRelationDraft(null)}
            />
          )}
          {relationEdit && (
            <CompactRelationEditor
              relationDocument={relationEdit.document}
              documents={documents}
              position={relationEdit.position}
              onClose={() => setRelationEdit(null)}
            />
          )}
        </div>

        <aside className="graph-inspector">
          <section>
            <h2>
              Selection <span>{selectedIds.length}</span>
            </h2>
            {!selectedIds.length && (
              <p className="muted">
                Select nodes with click, Shift-click, or box selection. Double-click opens a
                document route.
              </p>
            )}
            {selected && (
              <>
                <div className="selection-badges">
                  <span className={`dtype dtype-${selected.dtype}`}>{selected.dtype}</span>
                  <span
                    className={`review-badge review-badge-${selected.verification?.verified === true ? "reviewed" : "unreviewed"}`}
                  >
                    {selected.verification?.verified === true ? "reviewed" : "unreviewed"}
                  </span>
                </div>
                <h3>{documentLabel(selected)}</h3>
                <code>{selected._id}</code>
                <small className="inspector-dataset">
                  Dataset: {selected.dataset || "unknown"}
                </small>
                {selected.summary && <p>{selected.summary}</p>}
                {selectedResearchScope && (
                  <div className="research-node-summary">
                    <span
                      className={`research-state research-state-${selected.data?.status || "draft"}`}
                    >
                      Research state: {selected.data?.status || "draft"}
                    </span>
                    <small>
                      {selectedResearchScope.inputs.length} inputs ·{" "}
                      {selectedResearchScope.outputs.length} outputs ·{" "}
                      {selectedResearchScope.actors.length} actors
                    </small>
                  </div>
                )}
                <div className="inspector-actions">
                  <Link
                    className="button small"
                    to={`/documents/${encodeURIComponent(selected._id)}`}
                  >
                    <ExternalLink size={14} /> Open
                  </Link>
                  <button
                    className="button small"
                    onClick={() =>
                      isResearchNode(selected)
                        ? setResearchDraft({ document: selected, position: null })
                        : setQuickEdit({ document: selected, position: null })
                    }
                  >
                    <Pencil size={14} /> Edit
                  </button>
                  {selectedResearchScope &&
                    !selectedResearchActive &&
                    ["draft", "queued", "running", "completed", "killed"].includes(
                      selectedResearchStatus
                    ) && (
                      <button
                        className="button small"
                        onClick={() => executeResearchAction("run", selected)}
                      >
                        <Play size={14} />{" "}
                        {["queued", "running"].includes(selectedResearchStatus)
                          ? "Continue"
                          : "Run"}
                      </button>
                    )}
                  {selectedResearchScope && selectedResearchActive && (
                    <button
                      className="button small"
                      onClick={() => executeResearchAction("pause", selected)}
                    >
                      <Pause size={14} /> Pause
                    </button>
                  )}
                  {selectedResearchScope && selectedResearchStatus === "paused" && (
                    <button
                      className="button small"
                      onClick={() => executeResearchAction("resume", selected)}
                    >
                      <Play size={14} /> Resume
                    </button>
                  )}
                  {selectedResearchScope &&
                    ["failed", "blocked"].includes(selectedResearchStatus) && (
                      <button
                        className="button small"
                        onClick={() => executeResearchAction("retry", selected)}
                      >
                        <RotateCcw size={14} /> Retry
                      </button>
                    )}
                  {selectedResearchScope &&
                    ["queued", "running", "paused", "blocked", "failed"].includes(
                      selectedResearchStatus
                    ) && (
                      <button
                        className="button small danger"
                        onClick={() => executeResearchAction("kill", selected)}
                      >
                        <Square size={14} /> Kill
                      </button>
                    )}
                  {selectedResearchScope && (
                    <button
                      className="button small"
                      disabled={!selectedResearchScope.outputs.length}
                      onClick={() => inspectResearchOutputs(selected)}
                    >
                      <Focus size={14} /> Outputs
                    </button>
                  )}
                </div>
              </>
            )}
            {selectedIds.length > 1 && (
              <div className="selection-list">
                {selectedIds.map((id) => (
                  <code key={id}>{id}</code>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2>Connection finder</h2>
            <select value={pathStart} onChange={(event) => setPathStart(event.target.value)}>
              <option value="">From…</option>
              {nodeOptions.map((node) => (
                <option key={node.data.id} value={node.data.id}>
                  {node.data.label}
                </option>
              ))}
            </select>
            <select value={pathEnd} onChange={(event) => setPathEnd(event.target.value)}>
              <option value="">To…</option>
              {nodeOptions.map((node) => (
                <option key={node.data.id} value={node.data.id}>
                  {node.data.label}
                </option>
              ))}
            </select>
            <button
              className="button small full"
              onClick={calculatePaths}
              disabled={!pathStart || !pathEnd}
            >
              <Network size={14} /> Find routes
            </button>
            <div className="path-results">
              {paths.map((path, index) => (
                <button
                  key={`${path.nodes.join(":")}:${index}`}
                  className={activePath === index ? "path-result active" : "path-result"}
                  onClick={() => applyPath(paths, index)}
                >
                  <strong>Route {index + 1}</strong>
                  <span>
                    {path.edges.length} hops · cost {path.cost.toFixed(2)}
                  </span>
                  <small>
                    {path.nodes
                      .map(
                        (id) => graph.nodes.find((node) => node.data.id === id)?.data.label || id
                      )
                      .join(" → ")}
                  </small>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2>Browser actors</h2>
            {!settings?.actorsEnabled && (
              <p className="muted">
                Built-in actors are ready. Enable custom actor code in Settings when needed.
              </p>
            )}
            {actorEntries.map(({ actor, builtin, availability }) => {
              const customDisabled = !builtin && !settings?.actorsEnabled;
              const reason = customDisabled
                ? "Custom actor execution is disabled."
                : availability.reason;
              const running = runningActorId === actor.id;
              return (
                <button
                  key={actor.id}
                  className="actor-button"
                  disabled={Boolean(runningActorId) || customDisabled || !availability.applicable}
                  title={reason || actor.description || actor.id}
                  onClick={() => executeActor(actor)}
                >
                  <Play size={14} />
                  <span>
                    <strong>{running ? "Running…" : actor.label}</strong>
                    <small>{reason || actor.description || actor.id}</small>
                  </span>
                </button>
              );
            })}
            {lastActorRun && (
              <div className="actor-result" role="status">
                <strong>{lastActorRun.produced} document(s) returned</strong>
                <span>{lastActorRun.message}</span>
              </div>
            )}
          </section>
        </aside>
      </div>

      {showGraphCreate && (
        <GraphCreate onCreate={createNamedGraph} onClose={() => setShowGraphCreate(false)} />
      )}
      {showMembershipAdd && (
        <GraphMembershipAdd
          documents={documents}
          existingIds={activeGraph?.documentIds || []}
          onAdd={addExistingDocuments}
          onClose={() => setShowMembershipAdd(false)}
          cpClient={cpClient}
          serverUrl={settings?.serverUrl || ""}
          serverToken={settings?.serverToken || ""}
          executeBatch={executeBatch}
          setNotice={setNotice}
        />
      )}
      {targetDocument && (
        <TargetSubmit document={targetDocument} onClose={() => setTargetDocument(null)} />
      )}
    </section>
  );
}
