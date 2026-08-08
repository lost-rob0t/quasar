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

export type ConnectionPhase =
  "connecting" | "connected" | "reconnecting" | "disconnected" | "disposed";

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
    settle(request);
  }

  function rejectAllPending(reason: string): void {
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
      eventBus.dispatch(envelope as unknown as EventEnvelope);
      return;
    }
    if (typeof envelope.id !== "string") return;

    const response = envelope as unknown as ResponseEnvelope;
    settlePending(response.id, (request) => {
      if (response.status === "error") {
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
    } catch {
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
    let nextSocket: WebSocket;
    try {
      nextSocket = new WebSocket(url);
    } catch {
      reconnect.markDisconnected();
      return;
    }
    socket = nextSocket;
    nextSocket.onopen = () => {
      if (socket === nextSocket) void synchronize();
    };
    nextSocket.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data as string));
      } catch {
        // Invalid server frames are ignored; requests still time out deterministically.
      }
    };
    nextSocket.onclose = () => {
      if (socket !== nextSocket) return;
      socket = null;
      synchronization += 1;
      rejectAllPending("WebSocket connection closed.");
      if (disposed) return;
      publishState({ phase: "disconnected", connected: false, synchronized: false });
      reconnect.markDisconnected();
    };
    nextSocket.onerror = () => {
      // Browsers follow an error with close; close owns cleanup and retry.
    };
  }

  function send<T = unknown>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
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
        settlePending(id, (request) =>
          request.reject(
            new ControlPlaneError("control-plane.unavailable", `Command ${command} timed out.`)
          )
        );
      }, DEFAULT_TIMEOUT);
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        workspaceId
      });
      socket.send(JSON.stringify(envelope));
    });
  }

  const snapshot = () => send<Record<string, unknown>>("workspace.snapshot");
  const transaction = (operations: unknown[], expectedRevision?: number) =>
    send("workspace.transaction", {
      operations,
      ...(expectedRevision === undefined ? {} : { expectedRevision })
    });

  function setWorkspace(id: string): void {
    workspaceId = id;
    eventBus.setWorkspace(id);
    if (socket?.readyState === WebSocket.OPEN) void synchronize();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    synchronization += 1;
    reconnect.stop();
    const current = socket;
    socket = null;
    current?.close();
    rejectAllPending("Client disposed.");
    eventBus.reset(workspaceId);
    snapshotListeners.clear();
    publishState({ phase: "disposed", connected: false, synchronized: false });
    connectionListeners.clear();
  }

  reconnect.start();
  connect();

  return {
    send,
    subscribe: (handler, names) => eventBus.subscribe(handler, names),
    onConnectionStateChange(listener) {
      connectionListeners.add(listener);
      listener(state);
      return () => connectionListeners.delete(listener);
    },
    onSnapshot(listener) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    snapshot,
    transaction,
    documentCreate: (document) => send("document.create", document),
    documentUpdate: (document) => send("document.update", document),
    documentDelete: (id) => send("document.delete", { id }),
    graphSnapshot: (graphId = "all-documents") => send("graph.snapshot", { graphId }),
    graphPut: (graph) => send("graph.workspace.put", graph),
    graphDelete: (id) => send("graph.workspace.delete", { id }),
    graphActivate: (id) => send("graph.workspace.activate", { id }),
    nodeCreate: (node) => send("graph.node.create", node),
    nodeUpdate: (node) => send("graph.node.update", node),
    nodeDelete: (graphId, id) => send("graph.node.delete", { graphId, id }),
    edgeCreate: (edge) => send("graph.edge.create", edge),
    edgeUpdate: (edge) => send("graph.edge.update", edge),
    edgeDelete: (graphId, id) => send("graph.edge.delete", { graphId, id }),
    getConnected: () => state.connected && state.synchronized,
    getRevision: () => eventBus.getRevision(workspaceId),
    setWorkspace,
    dispose
  };
}

let globalClient: ControlPlaneClient | null = null;

export function initializeControlPlane(url?: string): ControlPlaneClient {
  if (globalClient && !url) return globalClient;
  globalClient?.dispose();
  globalClient = createControlPlaneClient(url);
  return globalClient;
}

export function getControlPlane(): ControlPlaneClient | null {
  return globalClient;
}

export function getControlPlaneOrThrow(): ControlPlaneClient {
  if (!globalClient) {
    throw new ControlPlaneError("control-plane.unavailable", "Control plane is not initialized.");
  }
  return globalClient;
}
