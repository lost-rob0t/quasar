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

export async function cpSnapshot(): Promise<Record<string, unknown>> {
  return (await client().snapshot()) as Record<string, unknown>;
}

export async function cpTransaction(
  operations: unknown[],
  expectedRevision?: number
): Promise<Record<string, unknown>> {
  return (await client().transaction(operations, expectedRevision)) as Record<string, unknown>;
}

export function isControlPlaneConnected(): boolean {
  const c = getControlPlane();
  return c !== null && c.getConnected();
}

export { ControlPlaneError };
