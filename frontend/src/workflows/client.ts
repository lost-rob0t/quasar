import { getControlPlaneOrThrow } from "../control-plane";
import type { NodeDescriptor, StarIntelOperation, Workflow } from "./model";
import { builtInCatalog, operationsToNodes, workflowToLisp } from "./model";

const STORAGE_KEY = "quasar:fbp:workflows";

export function loadWorkflows(): Workflow[] {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || "[]") as Workflow[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function saveWorkflows(workflows: Workflow[]): void {
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(workflows));
}

export async function loadCatalog(): Promise<NodeDescriptor[]> {
  let local = builtInCatalog;
  try {
    const descriptors = (await getControlPlaneOrThrow().send("fbp.catalog.list")) as NodeDescriptor[];
    if (Array.isArray(descriptors) && descriptors.length) local = descriptors;
  } catch {
    // The editor remains useful in offline/browser-only mode.
  }
  const endpoint = globalThis.localStorage?.getItem("quasar:starintel-endpoint")?.trim();
  if (!endpoint) return local;
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/client-manifest.json`, {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return local;
    const manifest = (await response.json()) as {
      operations?: StarIntelOperation[];
      fbp_nodes?: NodeDescriptor[];
    };
    const remote = Array.isArray(manifest.fbp_nodes)
      ? manifest.fbp_nodes
      : operationsToNodes(manifest.operations || []);
    return [...local.filter((node) => !node.id.startsWith("starintel.operation/")), ...remote];
  } catch {
    return local;
  }
}

export async function validateRemote(workflow: Workflow): Promise<Record<string, unknown>> {
  return getControlPlaneOrThrow().send<Record<string, unknown>>("fbp.dsl.validate", {
    source: workflowToLisp(workflow)
  });
}

export async function startRemote(workflow: Workflow): Promise<Record<string, unknown>> {
  return getControlPlaneOrThrow().send<Record<string, unknown>>("fbp.run.start", {
    source: workflowToLisp(workflow)
  });
}

export async function stopRemote(id: string): Promise<Record<string, unknown>> {
  return getControlPlaneOrThrow().send<Record<string, unknown>>("fbp.run.stop", { id });
}

export async function deploymentPlan(workflow: Workflow): Promise<Record<string, unknown>> {
  return getControlPlaneOrThrow().send<Record<string, unknown>>("fbp.deployment.plan", {
    source: workflowToLisp(workflow)
  });
}

export async function deploy(workflow: Workflow): Promise<Record<string, unknown>> {
  return getControlPlaneOrThrow().send<Record<string, unknown>>("fbp.deployment.apply", {
    source: workflowToLisp(workflow)
  });
}
