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
  bulkSaveDocuments,
  databaseInfo,
  ensureStarIntelViews,
  exportDocuments,
  getSettings,
  getWorkspace,
  listDocuments,
  saveSettings,
  saveWorkspace,
  startLiveSync,
  syncOnce,
  queryView,
  queryViewCounts,
  watchDocuments
} from "./lib/db";
import { importFiles } from "./lib/importer";
import { applyOperation, operation, saveDocumentBatch } from "./lib/operations";
import {
  BUILTIN_ACTORS,
  actorApplicability,
  actorsForTarget,
  isBuiltinActor,
  runBrowserActor
} from "./lib/actors";
import { actorWithTransformEnvelope, buildActorTransform } from "./lib/actor-transforms";
import { createResearchNodeRunner } from "./lib/research-node-runner";
import { startDocumentSource } from "./lib/document-source";
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
  updateActiveGraph
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
  const [researchRunState, setResearchRunState] = useState({});
  const syncRef = useRef(null);
  const queueRef = useRef(null);
  const queueIngestRef = useRef(null);
  const queueAutostartRef = useRef(false);
  const workspaceRef = useRef(null);
  const workspaceTimer = useRef(null);
  const researchRunnerRef = useRef(null);
  const documentsRef = useRef([]);
  const actorsRef = useRef([]);
  const runActorRef = useRef(null);
  const executeRef = useRef(null);

  documentsRef.current = documents;

  const refresh = useCallback(async () => setDocuments(await listDocuments()), []);

  useEffect(() => {
    let active = true;
    const source = startDocumentSource({
      load: listDocuments,
      watch: watchDocuments,
      onDocuments: (nextDocuments) => setDocuments(nextDocuments),
      onError: (error) => setNotice({ kind: "error", message: error.message })
    });
    Promise.all([source.initial, getSettings(), getWorkspace(), ensureStarIntelViews()])
      .then(([, nextSettings, nextWorkspace]) => {
        if (!active) return;
        applyTheme(nextSettings.theme);
        setSettings(nextSettings);
        workspaceRef.current = nextWorkspace;
        setWorkspace(nextWorkspace);
        setSelectedIds(nextWorkspace.selectedIds || []);
      })
      .catch((error) => setNotice({ kind: "error", message: error.message }))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      source.stop();
      syncRef.current?.cancel?.();
      queueRef.current?.cancel?.();
      researchRunnerRef.current?.dispose?.();
      clearTimeout(workspaceTimer.current);
    };
  }, []);

  const record = useCallback((entry) => {
    if (!entry?.inverse) return;
    setHistory((current) => ({ undo: [...current.undo.slice(-99), entry], redo: [] }));
  }, []);

  const execute = useCallback(
    async (command, label = command.type) => {
      const applied = await applyOperation(command);
      record({ label, inverse: applied.inverse, redo: command });
      await refresh();
      return applied.result;
    },
    [record, refresh]
  );
  executeRef.current = execute;

  const executeBatch = useCallback(
    async (nextDocuments, label = "Save documents", options = {}) => {
      const applied = await saveDocumentBatch(nextDocuments, label, options);
      record({
        label,
        inverse: applied.inverse,
        redo: operation.batch(applied.savedDocuments.map(operation.save), label)
      });
      await refresh();
      return applied.result;
    },
    [record, refresh]
  );

  const undo = useCallback(async () => {
    const entry = history.undo.at(-1);
    if (!entry) return;
    const applied = await applyOperation(entry.inverse);
    setHistory((current) => ({
      undo: current.undo.slice(0, -1),
      redo: [...current.redo, { label: entry.label, inverse: applied.inverse }]
    }));
    await refresh();
  }, [history.undo, refresh]);

  const redo = useCallback(async () => {
    const entry = history.redo.at(-1);
    if (!entry) return;
    const applied = await applyOperation(entry.inverse);
    setHistory((current) => ({
      undo: [...current.undo, { label: entry.label, inverse: applied.inverse }],
      redo: current.redo.slice(0, -1)
    }));
    await refresh();
  }, [history.redo, refresh]);

  const importFileSet = useCallback(
    async (files, options = {}) => {
      try {
        const report = await importFiles(
          files,
          async (candidates, importOptions) => {
            const label = `Import ${candidates.length} documents`;
            try {
              const applied = await saveDocumentBatch(candidates, label, {
                replace: Boolean(importOptions.replace),
                atomic: importOptions.atomic !== false,
                origins: importOptions.origins || []
              });
              record({
                label,
                inverse: applied.inverse,
                redo: operation.batch(applied.savedDocuments.map(operation.save), "Redo import")
              });
              return applied.result;
            } catch (error) {
              if (error.applied?.inverse) {
                record({
                  label,
                  inverse: error.applied.inverse,
                  redo: operation.batch(
                    error.applied.savedDocuments.map(operation.save),
                    "Redo import"
                  )
                });
              }
              throw error;
            }
          },
          { atomic: true, ...options }
        );
        await refresh();
        return report;
      } catch (error) {
        await refresh();
        throw error;
      }
    },
    [record, refresh]
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

  const commitWorkspace = useCallback((normalized) => {
    workspaceRef.current = normalized;
    setWorkspace(normalized);
    setSelectedIds(normalized.selectedIds || []);
    clearTimeout(workspaceTimer.current);
    workspaceTimer.current = setTimeout(
      () =>
        saveWorkspace(normalized).catch((error) => {
          setNotice({ kind: "error", message: error.message });
        }),
      120
    );
    return normalized;
  }, []);

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
    return commitWorkspace(deleteGraphWorkspace(workspaceRef.current || {}));
  }, [commitWorkspace]);

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
      return persistWorkspace({ selectedIds: normalized });
    },
    [persistWorkspace, selectedIds]
  );

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
        onChange: () => refresh().catch(() => {})
      });
    },
    [refresh, settings]
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
      researchRunState,
      history,
      canUndo: history.undo.length > 0,
      canRedo: history.redo.length > 0,
      execute,
      executeBatch,
      undo,
      redo,
      importFileSet,
      persistSettings,
      persistWorkspace,
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
      bulkSaveDocuments,
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
      history,
      execute,
      executeBatch,
      undo,
      redo,
      importFileSet,
      persistSettings,
      persistWorkspace,
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
