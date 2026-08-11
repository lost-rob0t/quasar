import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { applyTheme } from "../../lib/themes";
import { useQuasar } from "../../store";

const PROTOCOL = "auto-dig-quasar.v1";
const REQUEST_TIMEOUT_MS = 15_000;

function parentOrigin() {
  if (window.parent === window || !document.referrer) return null;
  try {
    return new URL(document.referrer).origin;
  } catch {
    return null;
  }
}

export function isAutoDigEmbedded() {
  return (
    window.parent !== window &&
    new URLSearchParams(window.location.search).get("host") === "auto-dig" &&
    parentOrigin() !== null
  );
}

class AutoDigBridgeClient {
  constructor(origin = parentOrigin()) {
    if (!origin) throw new Error("AutoDig bridge requires an embedded parent origin");
    this.origin = origin;
    this.listeners = new Set();
    this.pending = new Map();
    this.connected = false;
    window.addEventListener("message", this.onMessage);
  }

  async connect() {
    if (this.connected) return;
    await this.request("handshake", {
      childOrigin: window.location.origin,
      basePath: import.meta.env.BASE_URL
    });
    this.connected = true;
  }

  destroy() {
    window.removeEventListener("message", this.onMessage);
    for (const entry of this.pending.values()) {
      window.clearTimeout(entry.timer);
      entry.reject(new Error("AutoDig bridge closed"));
    }
    this.pending.clear();
    this.listeners.clear();
  }

  notify(type, payload) {
    window.parent.postMessage({ protocol: PROTOCOL, channel: "event", type, payload }, this.origin);
  }

  onMessage = (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== this.origin ||
      event.data?.protocol !== PROTOCOL
    ) {
      return;
    }

    if (event.data.channel === "event") {
      for (const listener of this.listeners) {
        listener({ type: event.data.type, payload: event.data.payload });
      }
      return;
    }

    if (event.data.channel !== "response") return;
    const entry = this.pending.get(event.data.id);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    this.pending.delete(event.data.id);
    if (event.data.ok) entry.resolve(event.data.result);
    else entry.reject(new Error(event.data.error || "AutoDig bridge request failed"));
  };

  request(method, params) {
    const id = `auto-dig-${Date.now().toString(36)}-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`AutoDig bridge timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      window.parent.postMessage(
        { protocol: PROTOCOL, channel: "request", id, method, params },
        this.origin
      );
    });
  }

  loadDataset(datasetId) {
    return this.request("loadDataset", { datasetId });
  }

  saveDocument(document) {
    return this.request("saveDocument", { document });
  }

  saveRelation(relation) {
    return this.request("saveRelation", { relation });
  }

  saveGraph(graph) {
    return this.request("saveGraph", { graph });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function documentIds(documents) {
  return documents.map((document) => document?._id).filter(Boolean);
}

function acceptedDocumentIds(report, fallbackDocuments = []) {
  const accepted = [...(report?.saved || []), ...(report?.skipped || [])]
    .map((item) => item?.id)
    .filter(Boolean);
  return accepted.length ? [...new Set(accepted)] : documentIds(fallbackDocuments);
}

function documentsFromEvent(event) {
  if (Array.isArray(event?.payload?.documents)) return event.payload.documents;
  if (Array.isArray(event?.payload)) return event.payload;
  return [];
}

export default function AutoDigHostBridge() {
  const { executeBatch, addDocumentsToActiveGraph, activeGraph, documents, setNotice } =
    useQuasar();
  const location = useLocation();
  const navigate = useNavigate();
  const bridgeRef = useRef(null);
  const datasetIdRef = useRef(null);
  const loadedDatasetRef = useRef(null);
  const pendingHostWrites = useRef(new Map());
  const mirroredDocuments = useRef(new Map());
  const mirroredGraph = useRef(null);

  const releaseHostWrite = useCallback((id) => {
    const count = pendingHostWrites.current.get(id) || 0;
    if (count <= 1) pendingHostWrites.current.delete(id);
    else pendingHostWrites.current.set(id, count - 1);
  }, []);

  const consumeHostWrite = useCallback(
    (id) => {
      if (!pendingHostWrites.current.has(id)) return false;
      releaseHostWrite(id);
      return true;
    },
    [releaseHostWrite]
  );

  const importHostDocuments = useCallback(
    async (documents) => {
      for (const id of documentIds(documents)) {
        pendingHostWrites.current.set(id, (pendingHostWrites.current.get(id) || 0) + 1);
      }

      let savedIds = new Set();
      try {
        const report = await executeBatch(documents, "Import AutoDig documents", {
          replace: false,
          atomic: false
        });
        savedIds = new Set(report.saved?.map((item) => item.id).filter(Boolean) || []);
        return report;
      } catch (error) {
        savedIds = new Set(error?.report?.saved?.map((item) => item.id).filter(Boolean) || []);
        throw error;
      } finally {
        for (const id of documentIds(documents)) {
          if (!savedIds.has(id)) releaseHostWrite(id);
        }
      }
    },
    [executeBatch, releaseHostWrite]
  );

  useEffect(() => {
    if (!isAutoDigEmbedded()) return undefined;

    const bridge = new AutoDigBridgeClient();
    bridgeRef.current = bridge;
    let active = true;

    const unsubscribe = bridge.subscribe((event) => {
      if (!active) return;

      if (event.type === "dataset-changed") {
        datasetIdRef.current = event.payload?.datasetId || null;
        loadedDatasetRef.current = null;
      }

      if (event.type === "actor-findings" || event.type === "dataset-documents") {
        const documents = documentsFromEvent(event);
        if (!documents.length) return;
        importHostDocuments(documents)
          .then((report) => addDocumentsToActiveGraph(acceptedDocumentIds(report, documents)))
          .catch((error) => setNotice({ kind: "error", message: error.message }));
      }

      if (event.type === "theme-changed" && typeof event.payload?.theme === "string") {
        applyTheme(event.payload.theme);
      }

      if (
        event.type === "navigate" &&
        typeof event.payload?.route === "string" &&
        event.payload.route.startsWith("/")
      ) {
        navigate(event.payload.route);
      }
    });

    bridge
      .connect()
      .then(async () => {
        const datasetId = await bridge.request("getActiveDatasetId");
        if (!active || !datasetId) return;
        datasetIdRef.current = datasetId;
        const dataset = await bridge.loadDataset(datasetId);
        if (!active) return;
        const documents = Array.isArray(dataset?.documents) ? dataset.documents : [];
        if (documents.length) {
          const report = await importHostDocuments(documents);
          const ids = acceptedDocumentIds(report, documents);
          if (ids.length) addDocumentsToActiveGraph(ids);
        }
        loadedDatasetRef.current = datasetId;
        setNotice({
          kind: "success",
          message: `Loaded AutoDig dataset ${datasetId}`
        });
      })
      .catch((error) => {
        if (active) setNotice({ kind: "error", message: error.message });
      });

    return () => {
      active = false;
      unsubscribe();
      bridge.destroy();
      bridgeRef.current = null;
    };
  }, [addDocumentsToActiveGraph, importHostDocuments, navigate, setNotice]);

  useEffect(() => {
    if (!isAutoDigEmbedded()) return undefined;
    const bridge = bridgeRef.current;
    if (!bridge) return undefined;
    const currentIds = new Set();
    for (const document of documents) {
      if (!document?._id || document._id.startsWith("_design/")) continue;
      currentIds.add(document._id);
      const fingerprint = JSON.stringify(document);
      if (mirroredDocuments.current.get(document._id) === fingerprint) continue;
      mirroredDocuments.current.set(document._id, fingerprint);
      if (consumeHostWrite(document._id)) continue;
      const save =
        document.dtype === "relation"
          ? bridge.saveRelation(document)
          : bridge.saveDocument(document);
      save.catch((error) =>
        setNotice({
          kind: "error",
          message: `AutoDig mirror failed: ${error.message}`
        })
      );
    }
    for (const id of mirroredDocuments.current.keys()) {
      if (!currentIds.has(id)) mirroredDocuments.current.delete(id);
    }
    return undefined;
  }, [consumeHostWrite, documents, setNotice]);

  useEffect(() => {
    if (!isAutoDigEmbedded() || !activeGraph) return undefined;
    const bridge = bridgeRef.current;
    if (!bridge) return undefined;
    const fingerprint = JSON.stringify(activeGraph);
    if (mirroredGraph.current === fingerprint) return undefined;
    mirroredGraph.current = fingerprint;
    bridge.saveGraph(activeGraph).catch((error) =>
      setNotice({
        kind: "error",
        message: `Graph mirror failed: ${error.message}`
      })
    );
    return undefined;
  }, [activeGraph, setNotice]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    bridge.notify("route-changed", {
      route: `${location.pathname}${location.search}${location.hash}`
    });
  }, [location.hash, location.pathname, location.search]);

  return null;
}
