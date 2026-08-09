import {
  PROTOCOL_VERSION,
  ControlPlaneError,
  type CommandEnvelope,
  type EventEnvelope,
  type EventHandler,
  type ResponseEnvelope
} from "./protocol";
import { createEventBus } from "./events";
import { createReconnectManager } from "./reconnect";

const DEFAULT_TIMEOUT = 10_000;
const TRANSACTION_TIMEOUT = 120_000;
const SNAPSHOT_PAGE_BYTES = 512 * 1024;
const SNAPSHOT_PAGE_INTERVAL_MS = 25;
const MAX_SNAPSHOT_PAGES = 10_000;
const CONTROL_PLANE_ERROR_EVENT = "quasar:control-plane-error";

export type ConnectionPhase =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "disposed";

export interface ConnectionState {
  phase: ConnectionPhase;
  connected: boolean;
  synchronized: boolean;
  attempts: number;
}

type ConnectionListener = (state: ConnectionState) => void;
type SnapshotListener = (snapshot: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: ControlPlaneError) => void;
  timer: ReturnType<typeof setTimeout>;
  workspaceId: string;
}

export interface ControlPlaneClient {
  send<T = unknown>(command: string, payload?: Record<string, unknown>): Promise<T>;
  subscribe(handler: EventHandler, eventNames?: string[]): () => void;
  onConnectionStateChange(listener: ConnectionListener): () => void;
  onSnapshot(listener: SnapshotListener): () => void;
  snapshot(): Promise<Record<string, unknown>>;
  transaction(operations: unknown[], expectedRevision?: number): Promise<unknown>;
  importDocuments(chunks: unknown[][]): Promise<unknown>;
  documentCreate(doc: Record<string, unknown>): Promise<unknown>;
  documentUpdate(doc: Record<string, unknown>): Promise<unknown>;
  documentDelete(id: string): Promise<unknown>;
  graphSnapshot(graphId?: string): Promise<unknown>;
  graphPut(graph: Record<string, unknown>): Promise<unknown>;
  graphDelete(id: string): Promise<unknown>;
  graphActivate(id: string): Promise<unknown>;
  nodeCreate(node: Record<string, unknown>): Promise<unknown>;
  nodeUpdate(node: Record<string, unknown>): Promise<unknown>;
  nodeDelete(graphId: string, id: string): Promise<unknown>;
  edgeCreate(edge: Record<string, unknown>): Promise<unknown>;
  edgeUpdate(edge: Record<string, unknown>): Promise<unknown>;
  edgeDelete(graphId: string, id: string): Promise<unknown>;
  getConnected(): boolean;
  getRevision(): number;
  setWorkspace(workspaceId: string): void;
  dispose(): void;
}

let sequence = 0;

function diagnosticsEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  try {
    const requested = new URLSearchParams(window.location.search).get("debug");
    if (requested === "1") window.localStorage.setItem("quasar-debug", "1");
    if (requested === "0") window.localStorage.removeItem("quasar-debug");
    return requested === "1" || window.localStorage.getItem("quasar-debug") === "1";
  } catch {
    return false;
  }
}

function traceTransport(event: string, fields: Record<string, unknown> = {}): void {
  if (!diagnosticsEnabled()) return;
  console.debug(`[quasar-control:${event}] ${JSON.stringify(fields)}`);
}

function reportControlPlaneError(
  message: string,
  fields: Record<string, unknown> = {}
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(CONTROL_PLANE_ERROR_EVENT, {
      detail: {
        message,
        ...fields
      }
    })
  );
}

function nextId(): string {
  sequence += 1;
  return `ui-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function defaultWebSocketUrl(): string {
  if (typeof window === "undefined") return "ws://127.0.0.1:8081";
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const token = document
    .querySelector<HTMLMetaElement>('meta[name="quasar-session-token"]')
    ?.content.trim();
  const query = token ? `?session=${encodeURIComponent(token)}` : "";
  return `${scheme}://${window.location.hostname}:8081${query}`;
}

export function createControlPlaneClient(url = defaultWebSocketUrl()): ControlPlaneClient {
  const eventBus = createEventBus();
  const pending = new Map<string, PendingRequest>();
  const connectionListeners = new Set<ConnectionListener>();
  const snapshotListeners = new Set<SnapshotListener>();
  let socket: WebSocket | null = null;
  let workspaceId =
    typeof window === "undefined"
      ? "default"
      : window.sessionStorage.getItem("quasar-workspace") || "default";
  let disposed = false;
  let openedOnce = false;
  let synchronization = 0;
  let state: ConnectionState = {
    phase: "connecting",
    connected: false,
    synchronized: false,
    attempts: 0
  };

  function publishState(next: Partial<ConnectionState>): void {
    state = { ...state, ...next };
    traceTransport("state", { ...state });
    for (const listener of connectionListeners) {
      try {
        listener(state);
      } catch {
        // Connection observers do not own the transport lifecycle.
      }
    }
  }

  const reconnect = createReconnectManager(connect, (next) => {
    if (!next.connected) {
      publishState({
        phase: openedOnce ? "reconnecting" : "connecting",
        connected: false,
        synchronized: false,
        attempts: next.attempts
      });
    }
  });

  function settlePending(id: string, settle: (request: PendingRequest) => void): void {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    traceTransport("settle", { id, workspace: request.workspaceId, pending: pending.size });
    settle(request);
  }

  function rejectAllPending(reason: string): void {
    traceTransport("reject-all", { reason, pending: pending.size });
    for (const id of [...pending.keys()]) {
      settlePending(id, (request) =>
        request.reject(new ControlPlaneError("control-plane.unavailable", reason))
      );
    }
  }

  function handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const envelope = message as Record<string, unknown>;
    if (envelope.protocol !== PROTOCOL_VERSION) return;
    if (typeof envelope.event === "string") {
      traceTransport("event", {
        event: envelope.event,
        workspace: envelope.workspace,
        revision: envelope.revision,
        operationId: envelope.operationId,
        transactionId: envelope.transactionId
      });
      eventBus.dispatch(envelope as unknown as EventEnvelope);
      return;
    }
    if (typeof envelope.id !== "string") return;

    const response = envelope as unknown as ResponseEnvelope;
    traceTransport("response", {
      id: response.id,
      status: response.status,
      revision:
        response.status === "ok"
          ? (response.result as Record<string, unknown> | null)?.revision
          : undefined
    });
    settlePending(response.id, (request) => {
      if (response.status === "error") {
        reportControlPlaneError(response.error.message, {
          code: response.error.code,
          workspace: request.workspaceId
        });
        request.reject(
          new ControlPlaneError(response.error.code, response.error.message, response.error.details)
        );
        return;
      }
      const result = response.result as Record<string, unknown> | null;
      if (typeof result?.revision === "number") {
        eventBus.setRevision(result.revision, request.workspaceId);
      }
      request.resolve(response.result);
    });
  }

  async function synchronize(): Promise<void> {
    const attempt = ++synchronization;
    const synchronizedWorkspace = workspaceId;
    traceTransport("synchronize-start", { attempt, workspace: synchronizedWorkspace });
    try {
      const current = await snapshot();
      if (
        disposed ||
        socket?.readyState !== WebSocket.OPEN ||
        attempt !== synchronization ||
        synchronizedWorkspace !== workspaceId
      )
        return;
      eventBus.reset(synchronizedWorkspace);
      if (typeof current.revision === "number") {
        eventBus.setRevision(current.revision, synchronizedWorkspace);
      }
      for (const listener of snapshotListeners) {
        try {
          listener(current);
        } catch {
          // Projection observers cannot interrupt transport synchronization.
        }
      }
      reconnect.markConnected();
      openedOnce = true;
      publishState({ phase: "connected", connected: true, synchronized: true, attempts: 0 });
      traceTransport("synchronize-complete", {
        attempt,
        workspace: synchronizedWorkspace,
        revision: current.revision
      });
    } catch (error) {
      const code =
        error instanceof ControlPlaneError
          ? error.code
          : error instanceof Error
            ? error.name
            : "unknown";
      traceTransport("synchronize-failed", {
        attempt,
        workspace: synchronizedWorkspace,
        error: code
      });
      reportControlPlaneError("Workspace synchronization failed.", {
        code,
        workspace: synchronizedWorkspace,
        attempt
      });
      socket?.close();
    }
  }

  function connect(): void {
    if (
      disposed ||
      socket?.readyState === WebSocket.CONNECTING ||
      socket?.readyState === WebSocket.OPEN
    ) {
      return;
    }
    publishState({
      phase: openedOnce ? "reconnecting" : "connecting",
      connected: false,
      synchronized: false
    });
    traceTransport("connect", { workspace: workspaceId, openedOnce });
    let nextSocket: WebSocket;
    try {
      nextSocket = new WebSocket(url);
    } catch (error) {
      reportControlPlaneError("WebSocket construction failed.", {
        error: error instanceof Error ? error.message : String(error),
        workspace: workspaceId
      });
      reconnect.markDisconnected();
      return;
    }
    socket = nextSocket;
    nextSocket.onopen = () => {
      traceTransport("open", { workspace: workspaceId });
      if (socket === nextSocket) void synchronize();
    };
    nextSocket.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data as string));
      } catch {
        reportControlPlaneError("Invalid control-plane WebSocket frame received.", {
          workspace: workspaceId
        });
      }
    };
    nextSocket.onclose = () => {
      if (socket !== nextSocket) return;
      socket = null;
      traceTransport("close", { workspace: workspaceId, disposed, pending: pending.size });
      rejectAllPending("WebSocket connection closed.");
      if (disposed) return;
      publishState({ phase: "disconnected", connected: false, synchronized: false });
      reconnect.markDisconnected();
    };
    nextSocket.onerror = () => {
      traceTransport("socket-error", { workspace: workspaceId });
      reportControlPlaneError("WebSocket transport error.", { workspace: workspaceId });
      // Browsers follow an error with close; close owns cleanup and retry.
    };
  }

  function send<T = unknown>(
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reportControlPlaneError("WebSocket is not connected.", {
          command,
          workspace: workspaceId
        });
        reject(new ControlPlaneError("control-plane.unavailable", "WebSocket is not connected."));
        return;
      }
      const id = nextId();
      const envelope: CommandEnvelope = {
        protocol: PROTOCOL_VERSION,
        id,
        command,
        payload,
        metadata: { client: "quasar-ui", workspace: workspaceId }
      };
      const timer = setTimeout(() => {
        reportControlPlaneError(`Command ${command} timed out.`, {
          command,
          workspace: workspaceId
        });
        settlePending(id, (request) =>
          request.reject(
            new ControlPlaneError("control-plane.unavailable", `Command ${command} timed out.`)
          )
        );
      }, timeoutMs);
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        workspaceId
      });
      traceTransport("send", { id, command, workspace: workspaceId, pending: pending.size });
      socket.send(JSON.stringify(envelope));
    });
  }

  async function snapshot(): Promise<Record<string, unknown>> {
    let offset = 0;
    let revision: number | null = null;
    let metadata: Record<string, unknown> | null = null;
    const documents: unknown[] = [];

    for (let pageNumber = 0; pageNumber < MAX_SNAPSHOT_PAGES; pageNumber += 1) {
      const page = await send<Record<string, unknown>>(
        "workspace.snapshot",
        { documentOffset: offset, documentByteLimit: SNAPSHOT_PAGE_BYTES },
        TRANSACTION_TIMEOUT
      );
      const pageRevision = typeof page.revision === "number" ? page.revision : 0;
      if (revision === null) revision = pageRevision;
      else if (revision !== pageRevision) {
        throw new ControlPlaneError(
          "workspace.revision-conflict",
          "Workspace changed while its snapshot was being transferred."
        );
      }
      metadata ??= page;
      if (Array.isArray(page.documents)) {
        for (const document of page.documents) documents.push(document);
      }
      const documentPage = page.documentPage as Record<string, unknown> | undefined;
      if (!documentPage) return page;
      if (documentPage?.complete === true) {
        const complete: Record<string, unknown> = { ...metadata, documents };
        delete complete.documentPage;
        return complete;
      }
      const nextOffset = Number(documentPage?.nextOffset);
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
        throw new ControlPlaneError(
          "protocol.invalid-response",
          "Workspace snapshot pagination did not advance."
        );
      }
      offset = nextOffset;
      await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_PAGE_INTERVAL_MS));
    }
    throw new ControlPlaneError(
      "protocol.invalid-response",
      "Workspace snapshot exceeded the maximum page count."
    );
  }

  async function transaction(operations: unknown[], expectedRevision?: number): Promise<unknown> {
    const payload: Record<string, unknown> = { operations };
    if (typeof expectedRevision === "number") payload.expectedRevision = expectedRevision;
    return send("workspace.transaction", payload, TRANSACTION_TIMEOUT);
  }

  async function importDocuments(chunks: unknown[][]): Promise<unknown> {
    const importId = nextId();
    try {
      await send("workspace.import.begin", { importId }, TRANSACTION_TIMEOUT);
      for (let index = 0; index < chunks.length; index += 1) {
        await send(
          "workspace.import.chunk",
          { importId, index, documents: chunks[index] },
          TRANSACTION_TIMEOUT
        );
      }
      return await send("workspace.import.commit", { importId }, TRANSACTION_TIMEOUT);
    } catch (error) {
      if (socket?.readyState === WebSocket.OPEN) {
        try {
          await send("workspace.import.abort", { importId }, DEFAULT_TIMEOUT);
        } catch {
          // Preserve the original staged-import failure.
        }
      }
      throw error;
    }
  }

  function subscribe(handler: EventHandler, eventNames: string[] = []): () => void {
    return eventBus.subscribe(handler, eventNames);
  }

  function onConnectionStateChange(listener: ConnectionListener): () => void {
    connectionListeners.add(listener);
    listener(state);
    return () => connectionListeners.delete(listener);
  }

  function onSnapshot(listener: SnapshotListener): () => void {
    snapshotListeners.add(listener);
    return () => snapshotListeners.delete(listener);
  }

  function getConnected(): boolean {
    return state.connected && state.synchronized;
  }

  function getRevision(): number {
    return eventBus.getRevision(workspaceId);
  }

  function setWorkspace(nextWorkspaceId: string): void {
    const normalized = nextWorkspaceId.trim() || "default";
    if (normalized === workspaceId) return;
    workspaceId = normalized;
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("quasar-workspace", workspaceId);
    }
    synchronization += 1;
    eventBus.reset(workspaceId);
    if (socket?.readyState === WebSocket.OPEN) {
      void synchronize();
    }
  }

  function dispose(): void {
    disposed = true;
    synchronization += 1;
    reconnect.dispose();
    publishState({ phase: "disposed", connected: false, synchronized: false });
    rejectAllPending("Control plane disposed.");
    const current = socket;
    socket = null;
    current?.close();
    eventBus.clear();
    connectionListeners.clear();
    snapshotListeners.clear();
  }

  connect();

  return {
    send,
    subscribe,
    onConnectionStateChange,
    onSnapshot,
    snapshot,
    transaction,
    importDocuments,
    documentCreate: (doc) => send("document.create", { document: doc }, TRANSACTION_TIMEOUT),
    documentUpdate: (doc) => send("document.update", { document: doc }, TRANSACTION_TIMEOUT),
    documentDelete: (id) => send("document.delete", { id }, TRANSACTION_TIMEOUT),
    graphSnapshot: (graphId) => send("graph.snapshot", graphId ? { graphId } : {}),
    graphPut: (graph) => send("graph.workspace.put", { graph }, TRANSACTION_TIMEOUT),
    graphDelete: (id) => send("graph.workspace.delete", { id }, TRANSACTION_TIMEOUT),
    graphActivate: (id) => send("graph.workspace.activate", { id }, TRANSACTION_TIMEOUT),
    nodeCreate: (node) => send("graph.node.create", { node }, TRANSACTION_TIMEOUT),
    nodeUpdate: (node) => send("graph.node.update", { node }, TRANSACTION_TIMEOUT),
    nodeDelete: (graphId, id) =>
      send("graph.node.delete", { graphId, id }, TRANSACTION_TIMEOUT),
    edgeCreate: (edge) => send("graph.edge.create", { edge }, TRANSACTION_TIMEOUT),
    edgeUpdate: (edge) => send("graph.edge.update", { edge }, TRANSACTION_TIMEOUT),
    edgeDelete: (graphId, id) =>
      send("graph.edge.delete", { graphId, id }, TRANSACTION_TIMEOUT),
    getConnected,
    getRevision,
    setWorkspace,
    dispose
  };
}
