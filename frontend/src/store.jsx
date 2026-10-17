import { fromPouchDocument, toLegacyUiDocument } from "./lib/canonical-document";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  databaseInfo,
  ensureStarIntelViews,
  initializeSettings,
  documentsDb,
  createProjectionStage,
  saveSettings,
  startLiveSync,
  syncOnce
} from "./lib/db";
import { cpImportDocuments, cpTransaction } from "./control-plane/mutations";
import { getControlPlane } from "./control-plane/client";
import { chunkTransactionOperations } from "./control-plane/transaction-chunks";
import { importFiles } from "./lib/importer";
import { synchronizeProjection, importProjection } from "./control-plane/projection-sync";
import { existingImportIds } from "./control-plane/import-existence";
import { withMutationBase } from "./control-plane/mutation-base";
import { readGraphCatalog, readCompleteGraph } from "./control-plane/graph-session";
import { prepareActorInput, actorIdRecords } from "./control-plane/actor-input";
import { withWorkspaceScope } from "./control-plane/workspace-scope";
import { readCanonicalDocument } from "./control-plane/canonical-read";
import { commitDocumentEdit } from "./control-plane/document-edit";
import { exportWorkspaceToFile } from "./control-plane/browser-export";
import { operation } from "./lib/operations";
import { validateDocumentBatch } from "./lib/document-batch";
import {
  BUILTIN_ACTORS,
  actorApplicability,
  actorsForTarget,
  isBuiltinActor,
  runBrowserActor
} from "./lib/actors";
import {
  actorWithTransformEnvelope,
  buildActorTransform,
  normalizeActorTransformResult
} from "./lib/actor-transforms";
import { createResearchNodeRunner } from "./lib/research-node-runner";
import { startRabbitMqIngest } from "./lib/rabbitmq-ingest";
import { probeStarIntelServer, submitTargetToServer } from "./lib/starintel-server";
import { applyTheme } from "./lib/themes";
import {
  addDocumentsToActiveGraph as addDocumentsToGraphWorkspace,
  clearActiveGraph as clearGraphWorkspace,
  createGraph as createGraphWorkspace,
  deleteActiveGraph as deleteGraphWorkspace,
  getActiveGraph,
  removeDocumentsFromActiveGraph as removeDocumentsFromGraphWorkspace,
  renameActiveGraph as renameGraphWorkspace,
  updateActiveGraph,
  normalizeGraphWorkspace
} from "./lib/graph-workspaces";

const QuasarContext = createContext(null);

export function QuasarProvider({ children }) {
  const [documents, setDocuments] = useState([]);
  const [settings, setSettings] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [syncStatus, setSyncStatus] = useState({ state: "offline", message: "Local only" });
  const [serverStatus, setServerStatus] = useState({ state: "offline", message: "Not connected" });
  const [queueStatus, setQueueStatus] = useState({
    state: "offline",
    message: "Queue listener stopped",
    accepted: 0,
    rejected: 0
  });
  const [history, setHistory] = useState({ undo: [], redo: [] });
  const [controlPlaneStatus, setControlPlaneStatus] = useState({ connected: false, attempts: 0 });
  const [researchRunState, setResearchRunState] = useState({});
  const syncRef = useRef(null);
  const queueRef = useRef(null);
  const queueIngestRef = useRef(null);
  const queueAutostartRef = useRef(false);
  const workspaceRef = useRef(null);
  const workspaceTimer = useRef(null);
  const pendingWorkspaceCommit = useRef(null);
  const workspaceCommit = useRef(Promise.resolve());
  const researchRunnerRef = useRef(null);
  const documentsRef = useRef([]);
  const actorsRef = useRef([]);
  const runActorRef = useRef(null);
  const executeRef = useRef(null);
  const graphCommitVersion = useRef(0);
  const eventRefreshSuspensions = useRef(0);

  documentsRef.current = documents;

  const [bootstrap, setBootstrap] = useState(null);
  const [graphCatalogPage, setGraphCatalogPage] = useState(null);
  const workbenchId = useRef(`workbench-${globalThis.crypto?.randomUUID?.() || Date.now()}`);
  const requestedGraph = useRef(null);
  const graphBase = useRef(null);
  const graphRevision = useRef(null);
  const bootstrapRef = useRef(null);
  const refreshPending = useRef(null);
  const refreshQueued = useRef(false);
  const sessionGeneration = useRef(0);
  const emptyGraph = useCallback(
    () => ({
      id: workbenchId.current,
      name: "Empty workbench",
      documentIds: [],
      positions: {},
      selectedIds: [],
      layout: "cose"
    }),
    []
  );
  const catalogWorkspace = useCallback(
    (catalog, active) =>
      normalizeGraphWorkspace({
        graphs: [
          active,
          ...(catalog.graphs || [])
            .filter((row) => row.id !== active.id)
            .map((row) => ({
              id: row.id,
              name: row.name,
              documentIds: row.membershipMode === "all" ? null : []
            }))
        ],
        activeGraphId: active.id
      }),
    []
  );

  const refresh = useCallback(
    async function refreshWorkspace() {
      if (refreshPending.current) {
        refreshQueued.current = true;
        return refreshPending.current;
      }
      const client = getControlPlane();
      if (!client?.getConnected?.()) return;
      const generation = sessionGeneration.current;
      const editVersion = graphCommitVersion.current;
      const task = withWorkspaceScope(client, async (check) => {
        const nextBootstrap = await client.send("workspace.bootstrap", {});
        check();
        const catalog = await readGraphCatalog(client, nextBootstrap.revision);
        check();
        let loaded = null;
        if (requestedGraph.current && !pendingWorkspaceCommit.current) {
          loaded = await readCompleteGraph(client, requestedGraph.current, nextBootstrap.revision);
          check();
        }
        if (generation !== sessionGeneration.current || editVersion !== graphCommitVersion.current)
          return;
        bootstrapRef.current = nextBootstrap;
        setBootstrap(nextBootstrap);
        setGraphCatalogPage(catalog);
        if (pendingWorkspaceCommit.current) return;
        graphRevision.current = nextBootstrap.revision;
        graphBase.current = loaded?.graph || null;
        const active = loaded?.graph || emptyGraph();
        const catalogState = catalogWorkspace(catalog, active);
        const nextWorkspace =
          workspaceRef.current?.activeGraphId === active.id
            ? updateActiveGraph(catalogState, {
                selectedIds: workspaceRef.current.selectedIds || []
              })
            : catalogState;
        const nextDocuments = loaded?.documents || [];
        documentsRef.current = nextDocuments;
        workspaceRef.current = nextWorkspace;
        setDocuments(nextDocuments);
        setWorkspace(nextWorkspace);
        setSelectedIds(nextWorkspace.selectedIds || []);
        return nextBootstrap;
      });
      refreshPending.current = task;
      try {
        return await task;
      } finally {
        refreshPending.current = null;
        setLoading(false);
        if (refreshQueued.current) {
          refreshQueued.current = false;
          void refreshWorkspace().catch((error) =>
            setNotice({ kind: "error", message: error.message })
          );
        }
      }
    },
    [catalogWorkspace, emptyGraph]
  );

  const nextGraphPage = useCallback(async () => {
    if (!graphCatalogPage || graphCatalogPage.complete) return;
    try {
      const client = getControlPlane();
      if (!client) return;
      await withWorkspaceScope(client, async (check) => {
        const catalog = await readGraphCatalog(
          client,
          bootstrapRef.current.revision,
          graphCatalogPage.cursor
        );
        check();
        setGraphCatalogPage(catalog);
        const active = getActiveGraph(workspaceRef.current || {});
        const next = catalogWorkspace(catalog, active);
        workspaceRef.current = next;
        setWorkspace(next);
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }, [catalogWorkspace, graphCatalogPage]);

  useEffect(() => {
    let active = true;
    const cpClient = getControlPlane();
    let synchronized = false;
    const unsubConn = cpClient?.onConnectionStateChange((state) => {
      setControlPlaneStatus(state);
      if (!state.synchronized) {
        sessionGeneration.current += 1;
        requestedGraph.current = null;
        graphBase.current = null;
        graphRevision.current = null;
        bootstrapRef.current = null;
        setBootstrap(null);
        setGraphCatalogPage(null);
        clearTimeout(workspaceTimer.current);
        pendingWorkspaceCommit.current = null;
        documentsRef.current = [];
        setDocuments([]);
        workspaceRef.current = catalogWorkspace({ graphs: [] }, emptyGraph());
        setWorkspace(workspaceRef.current);
        setSelectedIds([]);
      } else if (!synchronized) {
        void refresh().catch((error) => setNotice({ kind: "error", message: error.message }));
      }
      synchronized = state.synchronized;
      if (state.phase === "disconnected") {
        setNotice({
          kind: "info",
          code: "control-plane.disconnected",
          message: "Connection interrupted. Reconnecting automatically…"
        });
      } else if (state.phase === "synchronizing" || (state.connected && state.synchronized)) {
        setNotice((current) => (current?.code === "control-plane.disconnected" ? null : current));
      }
    });
    const unsubEvents = cpClient?.subscribe(() => {
      if (!active) return;
      if (eventRefreshSuspensions.current) return;
      void refresh().catch((error) => setNotice({ kind: "error", message: error.message }));
    });
    Promise.all([initializeSettings(), ensureStarIntelViews()])
      .then(([nextSettings]) => {
        if (!active) return;
        applyTheme(nextSettings.theme);
        setSettings(nextSettings);
      })
      .catch((error) => setNotice({ kind: "error", message: error.message }))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      unsubConn?.();
      unsubEvents?.();
      syncRef.current?.cancel?.();
      queueRef.current?.cancel?.();
      researchRunnerRef.current?.dispose?.();
      clearTimeout(workspaceTimer.current);
    };
  }, [catalogWorkspace, emptyGraph, refresh]);

  const record = useCallback((entry) => {
    if (!entry?.inverse) return;
    setHistory((current) => ({ undo: [...current.undo.slice(-99), entry], redo: [] }));
  }, []);

  const execute = useCallback(
    async (
      command,
      label = command.type,
      { recordHistory = true, expectedRevision: requiredRevision } = {}
    ) => {
      if (command?.type === "save-document") {
        const doc = command.document;
        const client = getControlPlane();
        if (!client) throw new Error("Connect to the workspace before editing.");
        const { previous: existing, result } = await commitDocumentEdit(
          client,
          doc.id || doc._id,
          doc,
          command.intent
        );
        await refresh().catch((error) =>
          setNotice({ kind: "error", message: `Saved, but refresh failed: ${error.message}` })
        );
        const inverse = existing ? operation.save(existing) : operation.remove(doc.id || doc._id);
        if (recordHistory) record({ label, inverse, redo: command });
        return result;
      }
      if (command?.type === "remove-document") {
        const client = getControlPlane();
        if (!client) throw new Error("Connect to the workspace before editing.");
        const { previous: existing, result } = await commitDocumentEdit(client, command.id);
        await refresh().catch((error) =>
          setNotice({ kind: "error", message: `Saved, but refresh failed: ${error.message}` })
        );
        const inverse = existing ? operation.save(existing) : null;
        if (recordHistory) record({ label, inverse, redo: command });
        return result;
      }
      if (command?.type === "batch") {
        const applyBatch = async (known, expectedRevision) => {
          const inverses = [];
          const ops = (command.operations || []).map((op) => {
            if (op.type === "save-document") {
              const previous = known.get(op.document.id || op.document._id);
              if (recordHistory)
                inverses.push(
                  previous
                    ? operation.save(previous)
                    : operation.remove(op.document.id || op.document._id)
                );
              known.set(op.document.id || op.document._id, op.document);
              return {
                type: previous ? "document.update" : "document.create",
                payload: op.document
              };
            }
            if (op.type === "remove-document") {
              const previous = known.get(op.id);
              if (recordHistory && previous) inverses.push(operation.save(previous));
              known.delete(op.id);
              return { type: "document.delete", payload: { id: op.id } };
            }
            return op;
          });
          const chunks = recordHistory ? [ops] : chunkTransactionOperations(ops);
          let result = null;
          let committedOperationCount = 0;
          let failure = null;
          eventRefreshSuspensions.current += 1;
          try {
            if (recordHistory) {
              result = await cpTransaction(ops, expectedRevision);
              committedOperationCount = ops.length;
            } else {
              result = await cpImportDocuments(chunks);
              committedOperationCount = ops.length;
            }
          } catch (error) {
            error.committedOperationCount = committedOperationCount;
            failure = error;
          } finally {
            eventRefreshSuspensions.current -= 1;
            if (!eventRefreshSuspensions.current) {
              try {
                await refresh().catch((error) =>
                  setNotice({
                    kind: "error",
                    message: `Saved, but refresh failed: ${error.message}`
                  })
                );
              } catch (error) {
                setNotice({ kind: "error", message: `Refresh failed: ${error.message}` });
              }
            }
          }
          if (failure) throw failure;
          if (recordHistory && inverses.length) {
            record({
              label,
              inverse: operation.batch(inverses.reverse(), `Undo ${label}`),
              redo: command
            });
          }
          return {
            ...result,
            chunkCount: chunks.length,
            atomic: !recordHistory || chunks.length === 1
          };
        };
        if (recordHistory) {
          const client = getControlPlane();
          if (!client) throw new Error("Connect to the workspace before editing.");
          const ids = (command.operations || []).flatMap((op) =>
            op.type === "save-document"
              ? [op.document.id || op.document._id]
              : op.type === "remove-document"
                ? [op.id]
                : []
          );
          return withMutationBase(client, ids, ({ documents, revision }) => {
            if (requiredRevision !== undefined && revision !== requiredRevision)
              throw new Error("Documents changed before the operation could commit. Retry it.");
            return applyBatch(documents, revision);
          });
        }
        const client = getControlPlane();
        if (!client) throw new Error("Connect to the workspace before importing.");
        const ids = (command.operations || [])
          .map((op) => op.document?.id || op.document?._id || op.id)
          .filter(Boolean);
        return applyBatch(await existingImportIds(client, ids));
      }
      throw new TypeError(`Unknown operation type: ${command?.type || "<missing>"}`);
    },
    [record, refresh]
  );
  executeRef.current = execute;

  const executeBatch = useCallback(
    async (nextDocuments, label = "Save documents", options = {}) => {
      const preflight = validateDocumentBatch(nextDocuments, { origins: options.origins || [] });
      if (options.atomic !== false && preflight.errors.length) {
        const error = new Error(`Batch rejected ${preflight.errors.length} document(s)`);
        error.report = {
          saved: [],
          skipped: [],
          errors: preflight.errors,
          atomic: true,
          rolledBack: 0
        };
        throw error;
      }
      const replace = options.replace !== false;
      let existing;
      if (options.recordHistory !== false) {
        const client = getControlPlane();
        if (!client) throw new Error("Connect to the workspace before editing.");
        existing = await withMutationBase(
          client,
          preflight.validated.map(({ document }) => document.id || document._id),
          async ({ documents }) => documents
        );
      } else {
        const client = getControlPlane();
        if (!client) throw new Error("Connect to the workspace before importing.");
        existing = await existingImportIds(
          client,
          preflight.validated.map(({ document }) => document.id || document._id)
        );
      }
      const savedDocuments = [];
      const skipped = [];
      let atomicCommit = true;
      for (const { document } of preflight.validated) {
        if (existing.has(document.id || document._id) && !replace) {
          skipped.push({ id: document.id || document._id, reason: "exists" });
        } else {
          savedDocuments.push(fromPouchDocument(document));
        }
      }
      if (savedDocuments.length) {
        let execution;
        try {
          execution = await execute(
            operation.batch(savedDocuments.map(operation.save), label),
            label,
            {
              recordHistory: options.recordHistory !== false
            }
          );
        } catch (error) {
          const committed = Number(error.committedOperationCount || 0);
          error.report = {
            saved: savedDocuments.slice(0, committed).map((document) => ({
              id: document.id || document._id,
              ok: true
            })),
            skipped,
            errors: [
              {
                index: committed,
                id: savedDocuments[committed]?.id || savedDocuments[committed]?._id || null,
                message: error.message,
                phase: "write"
              }
            ],
            atomic: false,
            rolledBack: 0
          };
          throw error;
        }
        atomicCommit = execution.atomic;
      }
      const report = {
        saved: savedDocuments.map((document) => ({ id: document.id || document._id, ok: true })),
        skipped,
        errors: preflight.errors,
        atomic: options.atomic !== false && atomicCommit,
        rolledBack: 0
      };
      if (report.errors.length) {
        const error = new Error(`Batch rejected ${report.errors.length} document(s)`);
        error.report = report;
        throw error;
      }
      return report;
    },
    [execute]
  );

  const undo = useCallback(async () => {
    const entry = history.undo.at(-1);
    if (!entry) return;
    await execute(entry.inverse, `Undo ${entry.label}`, { recordHistory: false });
    setHistory((current) => ({
      undo: current.undo.slice(0, -1),
      redo: [...current.redo, entry]
    }));
  }, [execute, history.undo]);

  const redo = useCallback(async () => {
    const entry = history.redo.at(-1);
    if (!entry) return;
    await execute(entry.redo, `Redo ${entry.label}`, { recordHistory: false });
    setHistory((current) => ({
      undo: [...current.undo, entry],
      redo: current.redo.slice(0, -1)
    }));
  }, [execute, history.redo]);

  const importFileSet = useCallback(
    (files, options = {}) =>
      importFiles(
        files,
        (candidates, importOptions) =>
          executeBatch(candidates, `Import ${candidates.length} documents`, {
            replace: Boolean(importOptions.replace),
            atomic: importOptions.atomic !== false,
            origins: importOptions.origins || [],
            recordHistory: false
          }),
        { atomic: true, ...options }
      ),
    [executeBatch]
  );

  const persistSettings = useCallback(
    async (next) => {
      const normalized = { ...(settings || {}), ...next };
      applyTheme(normalized.theme);
      setSettings(normalized);
      await saveSettings(normalized);
      return normalized;
    },
    [settings]
  );

  const setLocalWorkspace = useCallback((normalized) => {
    workspaceRef.current = normalized;
    setWorkspace(normalized);
    setSelectedIds(normalized.selectedIds || []);
    return normalized;
  }, []);

  const reportGraphFailure = useCallback(
    (version, error) => {
      if (version !== graphCommitVersion.current) return;
      setNotice({ kind: "error", message: error.message });
      void refresh().catch(() => {});
    },
    [refresh]
  );

  const canonicalGraph = useCallback((graph) => {
    const base = graphBase.current?.id === graph.id ? graphBase.current : null;
    const original = base ? getActiveGraph({ graphs: [base], activeGraphId: base.id }) : {};
    const durable = { ...(base || {}) };
    for (const [key, value] of Object.entries(graph)) {
      if (
        key !== "selectedIds" &&
        (!base || JSON.stringify(value) !== JSON.stringify(original[key]))
      )
        durable[key] = value;
    }
    return durable;
  }, []);

  const sendWorkspaceCommit = useCallback(
    (normalized, version) => {
      pendingWorkspaceCommit.current = null;
      const active = getActiveGraph(normalized);
      const generation = sessionGeneration.current;
      const commit = workspaceCommit.current
        .catch(() => {})
        .then(async () => {
          if (generation !== sessionGeneration.current) throw new Error("Graph workspace changed.");
          const durable = canonicalGraph(active);
          eventRefreshSuspensions.current += 1;
          try {
            const result = await cpTransaction(
              [
                { type: "graph.put", payload: durable },
                { type: "graph.activate", payload: { id: active.id } }
              ],
              graphRevision.current
            );
            if (generation !== sessionGeneration.current)
              throw new Error("Graph workspace changed.");
            graphBase.current = durable;
            graphRevision.current = result.revision;
            return result;
          } finally {
            eventRefreshSuspensions.current -= 1;
            if (generation === sessionGeneration.current && !pendingWorkspaceCommit.current)
              void refresh().catch((error) => setNotice({ kind: "error", message: error.message }));
          }
        });
      workspaceCommit.current = commit;
      commit.catch((error) => reportGraphFailure(version, error));
      return commit;
    },
    [canonicalGraph, refresh, reportGraphFailure]
  );

  const commitWorkspace = useCallback(
    (normalized) => {
      if (graphRevision.current === null)
        throw new Error("Wait for the workspace bootstrap before editing graphs.");
      const nextGraph = getActiveGraph(normalized);
      if (
        nextGraph.documentIds?.length > 2000 ||
        nextGraph.nodes?.length > 1500 ||
        nextGraph.edges?.length > 3000
      )
        throw new Error("Graph edit exceeds the interactive graph budget.");
      requestedGraph.current = normalized.activeGraphId;
      setLocalWorkspace(normalized);
      clearTimeout(workspaceTimer.current);
      const version = ++graphCommitVersion.current;
      pendingWorkspaceCommit.current = { normalized, version };
      workspaceTimer.current = setTimeout(() => {
        workspaceTimer.current = null;
        sendWorkspaceCommit(normalized, version);
      }, 120);
      return normalized;
    },
    [sendWorkspaceCommit, setLocalWorkspace]
  );

  const flushWorkspace = useCallback(() => {
    const pending = pendingWorkspaceCommit.current;
    if (!pending) return workspaceCommit.current;
    clearTimeout(workspaceTimer.current);
    workspaceTimer.current = null;
    return sendWorkspaceCommit(pending.normalized, pending.version);
  }, [sendWorkspaceCommit]);

  const persistWorkspace = useCallback(
    (next) => {
      return commitWorkspace(updateActiveGraph(workspaceRef.current || {}, next));
    },
    [commitWorkspace]
  );

  const addDocumentsToActiveGraph = useCallback(
    (ids, changes = {}) => {
      return commitWorkspace(
        addDocumentsToGraphWorkspace(workspaceRef.current || {}, ids, changes)
      );
    },
    [commitWorkspace]
  );

  const ingestQueueDocuments = useCallback(
    async (nextDocuments) => {
      const report = await executeBatch(
        nextDocuments,
        `Queue ingest: ${nextDocuments.length} document(s)`,
        {
          replace: false,
          atomic: true
        }
      );
      const acceptedIds = [
        ...new Set(
          [...report.saved.map((item) => item.id), ...report.skipped.map((item) => item.id)].filter(
            Boolean
          )
        )
      ];
      if (acceptedIds.length) addDocumentsToActiveGraph(acceptedIds);
      return { count: acceptedIds.length, ids: acceptedIds, report };
    },
    [addDocumentsToActiveGraph, executeBatch]
  );

  useEffect(() => {
    queueIngestRef.current = ingestQueueDocuments;
  }, [ingestQueueDocuments]);

  const stopQueue = useCallback(() => {
    queueRef.current?.cancel?.();
    queueRef.current = null;
    setQueueStatus((current) => ({
      ...current,
      state: "offline",
      message: "Queue listener stopped"
    }));
  }, []);

  const startQueue = useCallback(
    (configuration = settings) => {
      queueRef.current?.cancel?.();
      setQueueStatus((current) => ({
        ...current,
        state: "connecting",
        message: "Connecting to RabbitMQ Web STOMP"
      }));
      queueRef.current = startRabbitMqIngest(configuration, {
        onStatus: (status) => setQueueStatus((current) => ({ ...current, ...status })),
        onDocuments: (nextDocuments) => queueIngestRef.current(nextDocuments),
        onDelivery: (delivery) =>
          setQueueStatus((current) => ({
            ...current,
            accepted: current.accepted + (delivery.state === "accepted" ? delivery.count : 0),
            rejected: current.rejected + (delivery.state === "rejected" ? 1 : 0),
            lastError: delivery.error || current.lastError || null
          })),
        onError: (error) =>
          setQueueStatus((current) => ({
            ...current,
            state: current.state === "active" ? "active" : "error",
            lastError: error.message
          }))
      });
      return queueRef.current;
    },
    [settings]
  );

  useEffect(() => {
    if (loading || queueAutostartRef.current || !settings?.rabbitEnabled) return;
    queueAutostartRef.current = true;
    try {
      startQueue(settings);
    } catch (error) {
      setQueueStatus((current) => ({ ...current, state: "error", message: error.message }));
    }
  }, [loading, settings, startQueue]);

  const removeDocumentsFromActiveGraph = useCallback(
    (ids) => {
      return commitWorkspace(removeDocumentsFromGraphWorkspace(workspaceRef.current || {}, ids));
    },
    [commitWorkspace]
  );

  const createGraph = useCallback(
    (name) => {
      return commitWorkspace(createGraphWorkspace(workspaceRef.current || {}, name));
    },
    [commitWorkspace]
  );

  const switchGraph = useCallback(
    async (id) => {
      const client = getControlPlane();
      if (!client) return;
      eventRefreshSuspensions.current += 1;
      try {
        await withWorkspaceScope(client, async (check) => {
          await flushWorkspace();
          check();
          const nextBootstrap = await client.send("workspace.bootstrap", {});
          check();
          const loaded = await readCompleteGraph(client, id, nextBootstrap.revision);
          check();
          const result = await client.transaction(
            [{ type: "graph.activate", payload: { id } }],
            nextBootstrap.revision
          );
          check();
          requestedGraph.current = id;
          graphBase.current = loaded.graph;
          graphRevision.current = result.revision;
          documentsRef.current = loaded.documents;
          setDocuments(loaded.documents);
          setLocalWorkspace(catalogWorkspace(graphCatalogPage || { graphs: [] }, loaded.graph));
        });
      } catch (error) {
        setNotice({ kind: "error", message: error.message });
      } finally {
        eventRefreshSuspensions.current -= 1;
      }
    },
    [catalogWorkspace, flushWorkspace, graphCatalogPage, setLocalWorkspace]
  );

  const renameGraph = useCallback(
    (name) => {
      return commitWorkspace(renameGraphWorkspace(workspaceRef.current || {}, name));
    },
    [commitWorkspace]
  );

  const deleteGraph = useCallback(async () => {
    const current = workspaceRef.current || {};
    const deletedId = getActiveGraph(current).id;
    const normalized = deleteGraphWorkspace(current);
    try {
      await flushWorkspace();
      await cpTransaction(
        [{ type: "graph.delete", payload: { id: deletedId } }],
        graphRevision.current
      );
      requestedGraph.current = null;
      graphBase.current = null;
      await refresh();
      if (normalized.activeGraphId !== workbenchId.current)
        await switchGraph(normalized.activeGraphId);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }, [flushWorkspace, refresh, switchGraph]);

  const clearGraph = useCallback(() => {
    return commitWorkspace(clearGraphWorkspace(workspaceRef.current || {}));
  }, [commitWorkspace]);

  const select = useCallback(
    (ids) => {
      const normalized = [...new Set(ids)];
      const currentIds = workspaceRef.current?.selectedIds || selectedIds;
      if (
        normalized.length === currentIds.length &&
        normalized.every((id, index) => id === currentIds[index])
      )
        return workspaceRef.current;
      return setLocalWorkspace(
        updateActiveGraph(workspaceRef.current || {}, {
          selectedIds: normalized
        })
      );
    },
    [selectedIds, setLocalWorkspace]
  );

  const exportDocuments = useCallback(async ({ signal } = {}) => {
    const client = getControlPlane();
    if (!client) throw new Error("Connect to the workspace before exporting.");
    return exportWorkspaceToFile(client, { signal });
  }, []);

  const startSync = useCallback(
    async (configuration = settings) => {
      syncRef.current?.cancel?.();
      setSyncStatus({ state: "connecting", message: "Connecting to CouchDB" });
      await synchronizeProjection(getControlPlane(), documentsDb, createProjectionStage);
      syncRef.current = startLiveSync(configuration, {
        onActive: () => setSyncStatus({ state: "active", message: "Replicating" }),
        onPaused: (error) =>
          setSyncStatus({
            state: error ? "retrying" : "synced",
            message: error ? error.message : "Up to date"
          }),
        onDenied: (error) => setSyncStatus({ state: "denied", message: error.message }),
        onError: (error) => setSyncStatus({ state: "error", message: error.message }),
        onChange: (info) => {
          if (info?.direction !== "pull") return;
          const pulled = Array.isArray(info.change?.docs)
            ? info.change.docs.filter((document) => !document?._deleted)
            : [];
          if (!pulled.length) return;
          executeBatch(pulled, "Import CouchDB changes", {
            replace: true,
            atomic: true
          }).catch((error) => setNotice({ kind: "error", message: error.message }));
        }
      });
    },
    [executeBatch, settings]
  );

  const stopSync = useCallback(() => {
    syncRef.current?.cancel?.();
    syncRef.current = null;
    setSyncStatus({ state: "offline", message: "Local only" });
  }, []);

  const synchronize = useCallback(
    async (direction = "both", configuration = settings) => {
      syncRef.current?.cancel?.();
      syncRef.current = null;
      setSyncStatus({ state: "active", message: `${direction} synchronization` });
      try {
        if (direction !== "pull")
          await synchronizeProjection(getControlPlane(), documentsDb, createProjectionStage);
        const result = await syncOnce(configuration, direction);
        if (direction !== "push") {
          await importProjection(getControlPlane(), documentsDb);
        }
        setSyncStatus({ state: "synced", message: "Synchronization complete" });
        await refresh();
        return result;
      } catch (error) {
        setSyncStatus({ state: "error", message: error.message });
        throw error;
      }
    },
    [refresh, settings]
  );

  const testServer = useCallback(
    async (configuration = settings) => {
      setServerStatus({ state: "connecting", message: "Probing StarIntel server" });
      try {
        const result = await probeStarIntelServer(configuration);
        setServerStatus({
          state: "active",
          message:
            result.mode === "v1"
              ? "Connected with v1 capabilities"
              : "Connected in legacy compatibility mode",
          result
        });
        return result;
      } catch (error) {
        setServerStatus({ state: "error", message: error.message });
        throw error;
      }
    },
    [settings]
  );

  const submitTarget = useCallback(
    async (target, configuration = settings) => {
      setServerStatus((current) => ({ ...current, state: "active", message: "Submitting target" }));
      try {
        const response = await submitTargetToServer(configuration, target);
        await execute(operation.save(target), `Submit target ${target._id}`);
        addDocumentsToActiveGraph([target._id]);
        setServerStatus((current) => ({ ...current, state: "active", message: "Target accepted" }));
        return response;
      } catch (error) {
        setServerStatus((current) => ({ ...current, state: "error", message: error.message }));
        throw error;
      }
    },
    [addDocumentsToActiveGraph, execute, settings]
  );

  const actors = useMemo(
    () => [...BUILTIN_ACTORS, ...(settings?.actors || [])],
    [settings?.actors]
  );
  actorsRef.current = actors;

  const runActor = useCallback(
    async (actor, requestedSelection = selectedIds, runOptions = {}) => {
      if (!isBuiltinActor(actor) && !settings?.actorsEnabled)
        throw new Error("Custom browser actors are disabled in settings");
      const client = getControlPlane();
      if (!client) throw new Error("Connect to the workspace before running actors.");
      return withWorkspaceScope(client, async (checkWorkspace, scopeSignal) => {
        const checkScope = () => {
          checkWorkspace();
          runOptions.signal?.throwIfAborted();
        };
        checkScope();
        const requested = Array.isArray(requestedSelection)
          ? requestedSelection
          : [requestedSelection];
        const input = await prepareActorInput(client, actor, requested, checkScope);
        const selection = input.selection;
        const availability = actorApplicability(actor, selection);
        if (!availability.applicable) throw new Error(availability.reason);
        const corpusDocuments = input.documents;
        const result = await runBrowserActor(
          actorWithTransformEnvelope(actor),
          {
            selection,
            documents: corpusDocuments.map((document) => ({ ...document })),
            workspace: { layout: workspace?.layout || "cose" },
            researchNodeId: runOptions.researchNodeId || "",
            runId: runOptions.runId || ""
          },
          {
            signal: runOptions.signal
              ? AbortSignal.any([runOptions.signal, scopeSignal])
              : scopeSignal,
            trusted: isBuiltinActor(actor),
            documentServices: {
              get: async (payload) =>
                (await actorIdRecords(client, [payload.id], input.revision, checkScope))[0] || null,
              query: async (payload) => {
                if (!Array.isArray(payload.ids))
                  throw new Error("Actor queries must specify a bounded set of document IDs.");
                return (await actorIdRecords(client, payload.ids, input.revision, checkScope))
                  .filter(
                    (doc) =>
                      (!payload.dataset || doc.dataset === payload.dataset) &&
                      (!payload.dtype || doc.dtype === payload.dtype)
                  )
                  .slice(0, Math.max(1, Math.min(Number(payload.limit) || 100, 1000)));
              }
            }
          }
        );
        checkScope();
        const label = `Actor: ${actor.label}`;
        const normalized = normalizeActorTransformResult(result);
        const touched = normalized.operations.map((op) => op.document?._id || op.id);
        const current = await actorIdRecords(client, touched, input.revision, checkScope);
        checkScope();
        const transform = buildActorTransform(result, current, label);
        const existingIds = new Set(current.map((document) => document._id));
        const newDocumentIds = transform.documents
          .map((document) => document._id)
          .filter((id) => !existingIds.has(id));
        if (transform.command)
          await execute(transform.command, label, { expectedRevision: input.revision });
        checkScope();
        if (transform.documents.length) {
          addDocumentsToActiveGraph(transform.documents.map((document) => document._id));
        }
        if (!runOptions.quiet) setNotice({ kind: "success", message: transform.message });
        return { ...result, ...transform, documents: transform.documents, newDocumentIds };
      });
    },
    [addDocumentsToActiveGraph, execute, selectedIds, settings?.actorsEnabled, workspace?.layout]
  );
  runActorRef.current = runActor;

  const getResearchRunner = useCallback(() => {
    if (!researchRunnerRef.current) {
      const client = getControlPlane();
      if (!client) throw new Error("Connect to the workspace before running research.");
      let valid = true;
      const checkScope = () => {
        if (!valid) throw new Error("Research workspace changed; restart the run.");
      };
      const unsubscribe = client.onConnectionStateChange((state) => {
        if (!state.synchronized) {
          valid = false;
          researchRunnerRef.current?.dispose();
          researchRunnerRef.current = null;
        }
      });
      if (!valid) {
        unsubscribe();
        checkScope();
      }
      const runner = createResearchNodeRunner({
        resolveActor: (id) => {
          checkScope();
          return actorsRef.current.find((actor) => actor.id === id);
        },
        resolveDocument: async (id, signal) => {
          checkScope();
          const document = await readCanonicalDocument(client, id, signal);
          checkScope();
          return document ? toLegacyUiDocument(document) : null;
        },
        runActor: (...args) => {
          checkScope();
          return runActorRef.current(...args);
        },
        saveNode: (document, label) => {
          checkScope();
          return executeRef.current(operation.save(document), label);
        },
        onStatus: (status) =>
          setResearchRunState((current) => ({
            ...current,
            [status.id]: status
          }))
      });
      researchRunnerRef.current = {
        ...runner,
        dispose() {
          valid = false;
          unsubscribe();
          runner.dispose();
        }
      };
    }
    return researchRunnerRef.current;
  }, []);

  const currentResearchNode = useCallback(async (documentOrId) => {
    const id = typeof documentOrId === "string" ? documentOrId : documentOrId?._id;
    const client = getControlPlane();
    if (!client) throw new Error("Connect to the workspace before running research.");
    const current = await readCanonicalDocument(client, id);
    if (!current) throw new Error(`Research node not found: ${id || "<missing>"}`);
    return toLegacyUiDocument(current);
  }, []);

  const runResearchNode = useCallback(
    async (documentOrId) => {
      const result = await getResearchRunner().run(await currentResearchNode(documentOrId));
      setNotice({
        kind: "success",
        message: `Research node ${result.data.status}: ${result.title}`
      });
      return result;
    },
    [currentResearchNode, getResearchRunner]
  );

  const pauseResearchNode = useCallback(
    async (documentOrId) => {
      const node = await currentResearchNode(documentOrId);
      const result = await getResearchRunner().pause(node._id);
      setNotice({ kind: "success", message: `Paused research node: ${node.title}` });
      return result;
    },
    [currentResearchNode, getResearchRunner]
  );

  const resumeResearchNode = useCallback(
    async (documentOrId) => {
      const result = await getResearchRunner().resume(await currentResearchNode(documentOrId));
      setNotice({
        kind: "success",
        message: `Research node ${result.data.status}: ${result.title}`
      });
      return result;
    },
    [currentResearchNode, getResearchRunner]
  );

  const retryResearchNode = useCallback(
    async (documentOrId) => {
      const result = await getResearchRunner().retry(await currentResearchNode(documentOrId));
      setNotice({
        kind: "success",
        message: `Research node ${result.data.status}: ${result.title}`
      });
      return result;
    },
    [currentResearchNode, getResearchRunner]
  );

  const killResearchNode = useCallback(
    async (documentOrId) => {
      const node = await currentResearchNode(documentOrId);
      const result = await getResearchRunner().kill(node._id);
      setNotice({ kind: "success", message: `Killed research node: ${node.title}` });
      return result;
    },
    [currentResearchNode, getResearchRunner]
  );

  const runTargetActors = useCallback(
    async (target) => {
      const candidates = actorsForTarget(actors, target);
      const reports = [];
      for (const actor of candidates) {
        try {
          const result = await runActor(actor, [target]);
          reports.push({
            actorId: actor.id,
            status: "completed",
            produced: result.documents.length
          });
        } catch (error) {
          reports.push({ actorId: actor.id, status: "failed", error: error.message });
        }
      }
      if (reports.length) {
        const failed = reports.filter((report) => report.status === "failed");
        setNotice({
          kind: failed.length ? "error" : "success",
          message: failed.length
            ? `Target saved; ${failed.length} actor(s) failed and ${reports.length - failed.length} completed.`
            : `Target saved; ${reports.length} actor(s) completed.`
        });
      }
      return reports;
    },
    [actors, runActor]
  );

  const activeGraph = useMemo(() => getActiveGraph(workspace || {}), [workspace]);

  const value = useMemo(
    () => ({
      documents,
      bootstrap,
      graphCatalogPage,
      nextGraphPage,
      refresh,
      settings,
      workspace,
      graphs: (workspace?.graphs || []).map((graph) => ({
        ...graph,
        documentCount:
          graph.id === workspace?.activeGraphId
            ? documents.length
            : graphCatalogPage?.graphs.find((row) => row.id === graph.id)?.documentCount
      })),
      activeGraph,
      selectedIds,
      selectedDocuments: documents.filter((document) => selectedIds.includes(document._id)),
      loading,
      notice,
      setNotice,
      syncStatus,
      serverStatus,
      queueStatus,
      controlPlaneStatus,
      execute,
      executeBatch,
      undo,
      redo,
      importFileSet,
      persistSettings,
      persistWorkspace,
      flushWorkspace,
      addDocumentsToActiveGraph,
      removeDocumentsFromActiveGraph,
      createGraph,
      switchGraph,
      renameGraph,
      deleteGraph,
      clearGraph,
      select,
      startSync,
      stopSync,
      synchronize,
      testServer,
      submitTarget,
      startQueue,
      stopQueue,
      actors,
      runActor,
      runTargetActors,
      runResearchNode,
      pauseResearchNode,
      resumeResearchNode,
      retryResearchNode,
      killResearchNode,
      exportDocuments,
      databaseInfo,
      bulkSaveDocuments: executeBatch,
      ensureStarIntelViews
    }),
    [
      documents,
      bootstrap,
      graphCatalogPage,
      nextGraphPage,
      refresh,
      settings,
      workspace,
      selectedIds,
      loading,
      notice,
      syncStatus,
      serverStatus,
      queueStatus,
      controlPlaneStatus,
      execute,
      executeBatch,
      undo,
      redo,
      importFileSet,
      persistSettings,
      persistWorkspace,
      flushWorkspace,
      addDocumentsToActiveGraph,
      removeDocumentsFromActiveGraph,
      createGraph,
      switchGraph,
      renameGraph,
      deleteGraph,
      clearGraph,
      activeGraph,
      select,
      startSync,
      stopSync,
      synchronize,
      testServer,
      submitTarget,
      startQueue,
      stopQueue,
      actors,
      runActor,
      runTargetActors,
      researchRunState,
      runResearchNode,
      pauseResearchNode,
      resumeResearchNode,
      retryResearchNode,
      killResearchNode
    ]
  );

  return <QuasarContext.Provider value={value}>{children}</QuasarContext.Provider>;
}

export function useQuasar() {
  const value = useContext(QuasarContext);
  if (!value) throw new Error("useQuasar must be used inside QuasarProvider");
  return value;
}
