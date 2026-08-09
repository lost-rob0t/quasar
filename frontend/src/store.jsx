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
  getSettings,
  listDocuments,
  replaceDocumentProjection,
  saveSettings,
  startLiveSync,
  syncOnce,
  queryView,
  queryViewCounts
} from "./lib/db";
import {
  cpDocumentCreate,
  cpDocumentUpdate,
  cpDocumentDelete,
  cpImportDocuments,
  cpSnapshot,
  cpTransaction
} from "./control-plane/mutations";
import { getControlPlane } from "./control-plane/client";
import { chunkTransactionOperations } from "./control-plane/transaction-chunks";
import { documentsToJsonl, downloadText, importFiles } from "./lib/importer";
import { operation } from "./lib/operations";
import { validateDocumentBatch } from "./lib/document-batch";
import {
  BUILTIN_ACTORS,
  actorApplicability,
  actorsForTarget,
  isBuiltinActor,
  runBrowserActor
} from "./lib/actors";
import { actorWithTransformEnvelope, buildActorTransform } from "./lib/actor-transforms";
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
  switchActiveGraph as switchGraphWorkspace,
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

  const applyAuthoritativeSnapshot = useCallback(async (snapshot) => {
    const nextDocuments = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
    const snapshotWorkspace = normalizeGraphWorkspace({
      graphs: Array.isArray(snapshot?.graphs) ? snapshot.graphs : [],
      activeGraphId: snapshot?.activeGraphId || "all-documents"
    });
    const transientSelection = workspaceRef.current?.selectedIds || [];
    const nextWorkspace = updateActiveGraph(snapshotWorkspace, {
      selectedIds: transientSelection
    });
    documentsRef.current = nextDocuments;
    workspaceRef.current = nextWorkspace;
    setDocuments(nextDocuments);
    setWorkspace(nextWorkspace);
    setSelectedIds(nextWorkspace.selectedIds || []);
    await replaceDocumentProjection(nextDocuments);
  }, []);

  const refresh = useCallback(async () => {
    const snapshot = await cpSnapshot();
    await applyAuthoritativeSnapshot(snapshot);
    return snapshot;
  }, [applyAuthoritativeSnapshot]);

  useEffect(() => {
    let active = true;
    const cpClient = getControlPlane();
    const unsubConn = cpClient?.onConnectionStateChange((state) => {
      setControlPlaneStatus(state);
      if (state.phase === "disconnected") {
        setNotice({ kind: "error", message: "The Common Lisp control plane disconnected." });
      }
    });
    const unsubSnapshot = cpClient?.onSnapshot((snapshot) => {
      if (active) {
        void applyAuthoritativeSnapshot(snapshot).finally(() => setLoading(false));
      }
    });
    const unsubEvents = cpClient?.subscribe(() => {
      if (!active) return;
      if (eventRefreshSuspensions.current) return;
      void refresh().catch((error) => setNotice({ kind: "error", message: error.message }));
    });
    Promise.all([getSettings(), ensureStarIntelViews()])
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
      unsubSnapshot?.();
      unsubEvents?.();
      syncRef.current?.cancel?.();
      queueRef.current?.cancel?.();
      researchRunnerRef.current?.dispose?.();
      clearTimeout(workspaceTimer.current);
    };
  }, [applyAuthoritativeSnapshot, refresh]);

  const record = useCallback((entry) => {
    if (!entry?.inverse) return;
    setHistory((current) => ({ undo: [...current.undo.slice(-99), entry], redo: [] }));
  }, []);

  const execute = useCallback(
    async (command, label = command.type, { recordHistory = true } = {}) => {
      if (command?.type === "save-document") {
        const doc = command.document;
        const existing = documentsRef.current.find((item) => item._id === doc._id) || null;
        let result;
        if (existing) {
          result = await cpDocumentUpdate(doc);
        } else {
          result = await cpDocumentCreate(doc);
        }
        await refresh();
        const inverse = existing ? operation.save(existing) : operation.remove(doc._id);
        if (recordHistory) record({ label, inverse, redo: command });
        return result;
      }
      if (command?.type === "remove-document") {
        const existing = documentsRef.current.find((item) => item._id === command.id) || null;
        const result = await cpDocumentDelete(command.id);
        await refresh();
        const inverse = existing ? operation.save(existing) : null;
        if (recordHistory) record({ label, inverse, redo: command });
        return result;
      }
      if (command?.type === "batch") {
        const known = new Map(documentsRef.current.map((document) => [document._id, document]));
        const inverses = [];
        const ops = (command.operations || []).map((op) => {
          if (op.type === "save-document") {
            const previous = known.get(op.document._id);
            if (recordHistory)
              inverses.push(
                previous ? operation.save(previous) : operation.remove(op.document._id)
              );
            known.set(op.document._id, op.document);
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
            result = await cpTransaction(ops);
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
              await refresh();
            } catch (error) {
              if (!failure) failure = error;
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
        return { ...result, chunkCount: chunks.length };
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
      const existing = new Map(documentsRef.current.map((document) => [document._id, document]));
      const savedDocuments = [];
      const skipped = [];
      let chunkCount = 1;
      for (const { document } of preflight.validated) {
        if (existing.has(document._id) && !replace) {
          skipped.push({ id: document._id, reason: "exists" });
        } else {
          savedDocuments.push(document);
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
              id: document._id,
              ok: true
            })),
            skipped,
            errors: [
              {
                index: committed,
                id: savedDocuments[committed]?._id || null,
                message: error.message,
                phase: "write"
              }
            ],
            atomic: false,
            rolledBack: 0
          };
          throw error;
        }
        chunkCount = execution.chunkCount;
      }
      const report = {
        saved: savedDocuments.map((document) => ({ id: document._id, ok: true })),
        skipped,
        errors: preflight.errors,
        atomic: options.atomic !== false && chunkCount === 1,
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
    const { selectedIds: _selectedIds, ...durable } = graph;
    return durable;
  }, []);

  const sendWorkspaceCommit = useCallback(
    (normalized, version) => {
      pendingWorkspaceCommit.current = null;
      const active = getActiveGraph(normalized);
      const commit = cpTransaction([
        { type: "graph.put", payload: canonicalGraph(active) },
        { type: "graph.activate", payload: { id: active.id } }
      ]);
      workspaceCommit.current = commit;
      commit.catch((error) => reportGraphFailure(version, error));
      return commit;
    },
    [canonicalGraph, reportGraphFailure]
  );

  const commitWorkspace = useCallback(
    (normalized) => {
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
    (id) => {
      return commitWorkspace(switchGraphWorkspace(workspaceRef.current || {}, id));
    },
    [commitWorkspace]
  );

  const renameGraph = useCallback(
    (name) => {
      return commitWorkspace(renameGraphWorkspace(workspaceRef.current || {}, name));
    },
    [commitWorkspace]
  );

  const deleteGraph = useCallback(() => {
    const current = workspaceRef.current || {};
    const deletedId = getActiveGraph(current).id;
    const normalized = deleteGraphWorkspace(current);
    clearTimeout(workspaceTimer.current);
    setLocalWorkspace(normalized);
    const version = ++graphCommitVersion.current;
    cpTransaction([
      { type: "graph.delete", payload: { id: deletedId } },
      { type: "graph.activate", payload: { id: normalized.activeGraphId } }
    ]).catch((error) => reportGraphFailure(version, error));
    return normalized;
  }, [reportGraphFailure, setLocalWorkspace]);

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

  const exportDocuments = useCallback(() => {
    downloadText("quasar-documents.jsonl", documentsToJsonl(documentsRef.current));
  }, []);

  const startSync = useCallback(
    (configuration = settings) => {
      syncRef.current?.cancel?.();
      setSyncStatus({ state: "connecting", message: "Connecting to CouchDB" });
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
      setSyncStatus({ state: "active", message: `${direction} synchronization` });
      try {
        const result = await syncOnce(configuration, direction);
        if (direction !== "push") {
          const pulled = await listDocuments();
          if (pulled.length) {
            await executeBatch(pulled, "Import CouchDB snapshot", {
              replace: true,
              atomic: true
            });
          }
        }
        setSyncStatus({ state: "synced", message: "Synchronization complete" });
        await refresh();
        return result;
      } catch (error) {
        setSyncStatus({ state: "error", message: error.message });
        throw error;
      }
    },
    [executeBatch, refresh, settings]
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
      const requested = Array.isArray(requestedSelection)
        ? requestedSelection
        : [requestedSelection];
      const explicitDocuments = requested.filter((item) => item && typeof item === "object");
      const requestedIds = requested
        .map((item) => (typeof item === "string" ? item : item?._id))
        .filter(Boolean);
      const corpus = new Map(documents.map((document) => [document._id, document]));
      explicitDocuments.forEach((document) => corpus.set(document._id, document));
      const selection = requestedIds.map((id) => corpus.get(id)).filter(Boolean);
      const availability = actorApplicability(actor, selection);
      if (!availability.applicable) throw new Error(availability.reason);
      const corpusDocuments = [...corpus.values()];
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
          signal: runOptions.signal,
          trusted: isBuiltinActor(actor)
        }
      );
      const label = `Actor: ${actor.label}`;
      const transform = buildActorTransform(result, corpusDocuments, label);
      const existingIds = new Set(corpusDocuments.map((document) => document._id));
      const newDocumentIds = transform.documents
        .map((document) => document._id)
        .filter((id) => !existingIds.has(id));
      if (transform.command) await execute(transform.command, label);
      if (transform.documents.length) {
        addDocumentsToActiveGraph(transform.documents.map((document) => document._id));
      }
      if (!runOptions.quiet) setNotice({ kind: "success", message: transform.message });
      return { ...result, ...transform, documents: transform.documents, newDocumentIds };
    },
    [
      addDocumentsToActiveGraph,
      documents,
      execute,
      selectedIds,
      settings?.actorsEnabled,
      workspace?.layout
    ]
  );
  runActorRef.current = runActor;

  const getResearchRunner = useCallback(() => {
    if (!researchRunnerRef.current) {
      researchRunnerRef.current = createResearchNodeRunner({
        resolveActor: (id) => actorsRef.current.find((actor) => actor.id === id),
        resolveDocument: (id) => documentsRef.current.find((document) => document._id === id),
        runActor: (...args) => runActorRef.current(...args),
        saveNode: (document, label) => executeRef.current(operation.save(document), label),
        onStatus: (status) =>
          setResearchRunState((current) => ({
            ...current,
            [status.id]: status
          }))
      });
    }
    return researchRunnerRef.current;
  }, []);

  const currentResearchNode = useCallback((documentOrId) => {
    const id = typeof documentOrId === "string" ? documentOrId : documentOrId?._id;
    const current = documentsRef.current.find((document) => document._id === id);
    if (!current) throw new Error(`Research node not found: ${id || "<missing>"}`);
    return current;
  }, []);

  const runResearchNode = useCallback(
    async (documentOrId) => {
      const result = await getResearchRunner().run(currentResearchNode(documentOrId));
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
      const node = currentResearchNode(documentOrId);
      const result = await getResearchRunner().pause(node._id);
      setNotice({ kind: "success", message: `Paused research node: ${node.title}` });
      return result;
    },
    [currentResearchNode, getResearchRunner]
  );

  const resumeResearchNode = useCallback(
    async (documentOrId) => {
      const result = await getResearchRunner().resume(currentResearchNode(documentOrId));
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
      const result = await getResearchRunner().retry(currentResearchNode(documentOrId));
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
      const node = currentResearchNode(documentOrId);
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
      settings,
      workspace,
      graphs: workspace?.graphs || [],
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
      ensureStarIntelViews,
      queryView,
      queryViewCounts
    }),
    [
      documents,
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
