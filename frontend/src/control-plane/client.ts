import {
  PROTOCOL_VERSION,
  ControlPlaneError,
  type CommandEnvelope,
  type ResponseEnvelope,
  type EventEnvelope,
  type EventHandler,
} from "./protocol";
import { createEventBus, type EventBus } from "./events";
import { createReconnectManager, type ReconnectManager } from "./reconnect";

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_WS_URL =
  typeof window !== "undefined"
    ? `ws://${window.location.hostname}:8081`
    : "ws://127.0.0.1:8081";

export interface ConnectionState {
  connected: boolean;
  attempts: number;
}

type ConnectionListener = (state: ConnectionState) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: ControlPlaneError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ControlPlaneClient {
  send<T = unknown>(command: string, payload?: Record<string, unknown>): Promise<T>;
  subscribe(handler: EventHandler, eventNames?: string[]): () => void;
  onConnectionStateChange(listener: ConnectionListener): () => void;
  snapshot(): Promise<unknown>;
  transaction(operations: unknown[], expectedRevision?: number): Promise<unknown>;
  documentCreate(doc: Record<string, unknown>): Promise<unknown>;
  documentUpdate(doc: Record<string, unknown>): Promise<unknown>;
  documentDelete(id: string): Promise<unknown>;
  graphSnapshot(graphId?: string): Promise<unknown>;
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

export function createControlPlaneClient(url: string = DEFAULT_WS_URL): ControlPlaneClient {
  const eventBus: EventBus = createEventBus();
  const pending = new Map<string, PendingRequest>();
  const connectionListeners = new Set<ConnectionListener>();
  let ws: WebSocket | null = null;
  let workspaceId = "default";
  let revision = 0;
  let disposed = false;

  function notifyConnectionState(state: ConnectionState): void {
    for (const listener of connectionListeners) {
      try {
        listener(state);
      } catch {
        // Listener errors must not break notification.
      }
    }
  }

  const reconnect: ReconnectManager = createReconnectManager(
    () => connect(),
    (state) => {
      notifyConnectionState({ connected: state.connected, attempts: state.attempts });
    }
  );

  function rejectAllPending(reason: string): void {
    for (const req of pending.values()) {
      clearTimeout(req.timer);
      req.reject(new ControlPlaneError("control-plane.unavailable", reason));
    }
    pending.clear();
  }

  async function resnapshotAfterReconnect(): Promise<void> {
    try {
      const snap = await send("workspace.snapshot");
      if (snap && typeof snap === "object" && "revision" in snap) {
        const r = snap as Record<string, unknown>;
        if (typeof r.revision === "number") {
          revision = r.revision;
          eventBus.setRevision(revision);
        }
      }
    } catch {
      // Snapshot may fail if the workspace was lost; non-fatal.
    }
  }

  function connect(): void {
    if (disposed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      reconnect.markDisconnected();
      return;
    }

    ws.onopen = () => {
      reconnect.markConnected();
      resnapshotAfterReconnect();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string);
        handleMessage(message);
      } catch {
        // Ignore malformed messages.
      }
    };

    ws.onclose = () => {
      ws = null;
      rejectAllPending("WebSocket connection closed.");
      if (!disposed) {
        reconnect.markDisconnected();
      }
    };

    ws.onerror = () => {
      // The close handler will fire and trigger reconnect.
    };
  }

  function handleMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const env = message as Record<string, unknown>;
    if (env.protocol !== PROTOCOL_VERSION) return;

    if (typeof env.event === "string") {
      eventBus.dispatch(env as unknown as EventEnvelope);
      return;
    }

    if (typeof env.id === "string") {
      const response = env as unknown as ResponseEnvelope;
      const req = pending.get(response.id);
      if (!req) return;
      pending.delete(response.id);
      clearTimeout(req.timer);
      if (response.status === "ok") {
        if (typeof response.result === "object" && response.result !== null) {
          const r = response.result as Record<string, unknown>;
          if (typeof r.revision === "number") {
            revision = r.revision;
            eventBus.setRevision(revision);
          }
        }
        req.resolve(response.result);
      } else {
        req.reject(
          new ControlPlaneError(
            response.error.code,
            response.error.message,
            response.error.details
          )
        );
      }
    }
  }

  function send<T = unknown>(
    command: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new ControlPlaneError("control-plane.unavailable", "WebSocket is not connected."));
        return;
      }
      const id = nextId();
      const envelope: CommandEnvelope = {
        protocol: PROTOCOL_VERSION,
        id,
        command,
        payload,
        metadata: {
          client: "quasar-ui",
          workspace: workspaceId,
        },
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ControlPlaneError("control-plane.unavailable", `Command ${command} timed out.`));
      }, DEFAULT_TIMEOUT);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify(envelope));
    });
  }

  function snapshot(): Promise<unknown> {
    return send("workspace.snapshot");
  }

  function transaction(operations: unknown[], expectedRevision?: number): Promise<unknown> {
    const payload: Record<string, unknown> = { operations };
    if (expectedRevision !== undefined) {
      payload.expectedRevision = expectedRevision;
    }
    return send("workspace.transaction", payload);
  }

  function documentCreate(doc: Record<string, unknown>): Promise<unknown> {
    return send("document.create", doc);
  }
  function documentUpdate(doc: Record<string, unknown>): Promise<unknown> {
    return send("document.update", doc);
  }
  function documentDelete(id: string): Promise<unknown> {
    return send("document.delete", { id });
  }

  function graphSnapshot(graphId: string = "default"): Promise<unknown> {
    return send("graph.snapshot", { graphId });
  }
  function nodeCreate(node: Record<string, unknown>): Promise<unknown> {
    return send("graph.node.create", node);
  }
  function nodeUpdate(node: Record<string, unknown>): Promise<unknown> {
    return send("graph.node.update", node);
  }
  function nodeDelete(graphId: string, id: string): Promise<unknown> {
    return send("graph.node.delete", { graphId, id });
  }
  function edgeCreate(edge: Record<string, unknown>): Promise<unknown> {
    return send("graph.edge.create", edge);
  }
  function edgeUpdate(edge: Record<string, unknown>): Promise<unknown> {
    return send("graph.edge.update", edge);
  }
  function edgeDelete(graphId: string, id: string): Promise<unknown> {
    return send("graph.edge.delete", { graphId, id });
  }

  function subscribe(handler: EventHandler, eventNames?: string[]): () => void {
    return eventBus.subscribe(handler, eventNames);
  }

  function onConnectionStateChange(listener: ConnectionListener): () => void {
    connectionListeners.add(listener);
    return () => {
      connectionListeners.delete(listener);
    };
  }

  function getConnected(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  function getRevision(): number {
    return revision;
  }

  function setWorkspace(id: string): void {
    workspaceId = id;
  }

  function dispose(): void {
    disposed = true;
    reconnect.stop();
    if (ws) {
      ws.close();
      ws = null;
    }
    rejectAllPending("Client disposed.");
    eventBus.reset();
    connectionListeners.clear();
  }

  reconnect.start();
  connect();

  return {
    send,
    subscribe,
    onConnectionStateChange,
    snapshot,
    transaction,
    documentCreate,
    documentUpdate,
    documentDelete,
    graphSnapshot,
    nodeCreate,
    nodeUpdate,
    nodeDelete,
    edgeCreate,
    edgeUpdate,
    edgeDelete,
    getConnected,
    getRevision,
    setWorkspace,
    dispose,
  };
}

let globalClient: ControlPlaneClient | null = null;

export function initializeControlPlane(url?: string): ControlPlaneClient {
  if (globalClient && !url) {
    return globalClient;
  }
  if (globalClient) {
    globalClient.dispose();
  }
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
