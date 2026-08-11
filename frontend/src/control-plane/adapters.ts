import { getControlPlaneOrThrow, type ControlPlaneClient } from "./client";
import { ControlPlaneError } from "./protocol";

export interface DocumentAdapter {
  create(document: Record<string, unknown>): Promise<unknown>;
  update(document: Record<string, unknown>): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  list(): Promise<unknown>;
  get(id: string): Promise<unknown>;
}

export interface GraphNodeAdapter {
  create(node: Record<string, unknown>): Promise<unknown>;
  update(node: Record<string, unknown>): Promise<unknown>;
  remove(graphId: string, id: string): Promise<unknown>;
  snapshot(graphId?: string): Promise<unknown>;
}

export interface GraphEdgeAdapter {
  create(edge: Record<string, unknown>): Promise<unknown>;
  update(edge: Record<string, unknown>): Promise<unknown>;
  remove(graphId: string, id: string): Promise<unknown>;
}

export interface WorkspaceAdapter {
  snapshot(): Promise<unknown>;
  transaction(operations: unknown[], expectedRevision?: number): Promise<unknown>;
  getRevision(): number;
}

export function createDocumentAdapter(client: ControlPlaneClient): DocumentAdapter {
  return {
    async create(document) {
      return client.documentCreate(document);
    },
    async update(document) {
      return client.documentUpdate(document);
    },
    async remove(id) {
      return client.documentDelete(id);
    },
    async list() {
      return client.send("document.list");
    },
    async get(id) {
      return client.send("document.get", { id });
    }
  };
}

export function createGraphNodeAdapter(client: ControlPlaneClient): GraphNodeAdapter {
  return {
    async create(node) {
      return client.nodeCreate(node);
    },
    async update(node) {
      return client.nodeUpdate(node);
    },
    async remove(graphId, id) {
      return client.nodeDelete(graphId, id);
    },
    async snapshot(graphId) {
      return client.graphSnapshot(graphId);
    }
  };
}

export function createGraphEdgeAdapter(client: ControlPlaneClient): GraphEdgeAdapter {
  return {
    async create(edge) {
      return client.edgeCreate(edge);
    },
    async update(edge) {
      return client.edgeUpdate(edge);
    },
    async remove(graphId, id) {
      return client.edgeDelete(graphId, id);
    }
  };
}

export function createWorkspaceAdapter(client: ControlPlaneClient): WorkspaceAdapter {
  return {
    async snapshot() {
      return client.snapshot();
    },
    async transaction(operations, expectedRevision) {
      return client.transaction(operations, expectedRevision);
    },
    getRevision() {
      return client.getRevision();
    }
  };
}

export function createAdapters(client?: ControlPlaneClient) {
  const c = client ?? getControlPlaneOrThrow();
  return {
    document: createDocumentAdapter(c),
    node: createGraphNodeAdapter(c),
    edge: createGraphEdgeAdapter(c),
    workspace: createWorkspaceAdapter(c),
    client: c
  };
}

export type Adapters = ReturnType<typeof createAdapters>;

export { ControlPlaneError };
