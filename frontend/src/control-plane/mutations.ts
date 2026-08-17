import { getControlPlane, type ControlPlaneClient } from "./client";
import { ControlPlaneError } from "./protocol";

export interface MutationResult {
  result: Record<string, unknown>;
  revision: number;
  operationId: string;
  workspaceId: string;
}

function client(): ControlPlaneClient {
  const c = getControlPlane();
  if (!c) {
    throw new ControlPlaneError("control-plane.unavailable", "Control plane is not initialized.");
  }
  return c;
}

export async function cpDocumentCreate(doc: Record<string, unknown>): Promise<MutationResult> {
  const r = (await client().documentCreate(doc)) as Record<string, unknown>;
  return r as unknown as MutationResult;
}

export async function cpDocumentUpdate(doc: Record<string, unknown>): Promise<MutationResult> {
  const r = (await client().documentUpdate(doc)) as Record<string, unknown>;
  return r as unknown as MutationResult;
}

export async function cpDocumentDelete(id: string): Promise<MutationResult> {
  const r = (await client().documentDelete(id)) as Record<string, unknown>;
  return r as unknown as MutationResult;
}

export async function cpNodeCreate(node: Record<string, unknown>): Promise<MutationResult> {
  const r = (await client().nodeCreate(node)) as Record<string, unknown>;
  return r as unknown as MutationResult;
}

export async function cpNodeUpdate(node: Record<string, unknown>): Promise<MutationResult> {
  const r = (await client().nodeUpdate(node)) as Record<string, unknown>;
  return r as unknown as MutationResult;
}

export async function cpNodeDelete(graphId: string, id: string): Promise<MutationResult> {
  const r = (await client().nodeDelete(graphId, id)) as Record<string, unknown>;
  return r as unknown as MutationResult;
}

export async function cpEdgeCreate(edge: Record<string, unknown>): Promise<MutationResult> {
  const r = (await client().edgeCreate(edge)) as Record<string, unknown>;
  return r as unknown as MutationResult;
}

export async function cpEdgeUpdate(edge: Record<string, unknown>): Promise<MutationResult> {
  const r = (await client().edgeUpdate(edge)) as Record<string, unknown>;
  return r as unknown as MutationResult;
}

export async function cpEdgeDelete(graphId: string, id: string): Promise<MutationResult> {
  const r = (await client().edgeDelete(graphId, id)) as Record<string, unknown>;
  return r as unknown as MutationResult;
}

export async function cpGraphPut(graph: Record<string, unknown>): Promise<MutationResult> {
  return (await client().graphPut(graph)) as MutationResult;
}

export async function cpGraphDelete(id: string): Promise<MutationResult> {
  return (await client().graphDelete(id)) as MutationResult;
}

export async function cpGraphActivate(id: string): Promise<MutationResult> {
  return (await client().graphActivate(id)) as MutationResult;
}

export async function cpSnapshot(): Promise<Record<string, unknown>> {
  return (await client().snapshot()) as Record<string, unknown>;
}

export async function cpTransaction(
  operations: unknown[],
  expectedRevision?: number
): Promise<Record<string, unknown>> {
  return (await client().transaction(operations, expectedRevision)) as Record<string, unknown>;
}

export async function cpImportDocuments(chunks: unknown[][]): Promise<Record<string, unknown>> {
  const c = client();
  const started = await c.send<Record<string, unknown>>("document.import.begin", {});
  const sessionId = String(started.sessionId || "");
  if (!sessionId) {
    throw new ControlPlaneError("protocol.invalid-envelope", "Import session ID is missing.");
  }

  try {
    for (let sequence = 0; sequence < chunks.length; sequence += 1) {
      const operations = chunks[sequence] ?? [];
      await c.send("document.import.chunk", { sessionId, sequence, operations });
    }
    return (await c.send("document.import.commit", { sessionId })) as Record<string, unknown>;
  } catch (error) {
    try {
      await c.send("document.import.abort", { sessionId });
    } catch {
      // A terminal conflict/commit may already have removed the durable stage.
    }
    throw error;
  }
}

export function isControlPlaneConnected(): boolean {
  const c = getControlPlane();
  return c !== null && c.getConnected();
}

export { ControlPlaneError };