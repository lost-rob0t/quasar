import { getControlPlaneOrThrow } from "../control-plane";
import type { NodeDescriptor, StarIntelOperation, Workflow } from "./model";
import { builtInCatalog, operationsToNodes, workflowToLisp } from "./model";

const WORKFLOW_DOCUMENT_ID_PREFIX = "quasar:fbp:workflow:";
const WORKFLOW_DOCUMENT_TYPE = "quasar.fbp.workflow";
const DOCUMENT_PAGE_BYTES = 512 * 1024;
const MAX_DOCUMENT_PAGES = 10_000;

type JsonObject = Record<string, unknown>;

interface WorkflowDocument extends JsonObject {
  _id: string;
  dtype: typeof WORKFLOW_DOCUMENT_TYPE;
  body: Workflow;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowDocumentId(id: string): string {
  return `${WORKFLOW_DOCUMENT_ID_PREFIX}${encodeURIComponent(id)}`;
}

function workflowDocument(workflow: Workflow): WorkflowDocument {
  return {
    _id: workflowDocumentId(workflow.id),
    dtype: WORKFLOW_DOCUMENT_TYPE,
    body: workflow,
  };
}

function isWorkflowDocument(value: unknown): value is JsonObject & {
  _id: string;
  dtype: typeof WORKFLOW_DOCUMENT_TYPE;
} {
  return (
    isObject(value) &&
    value.dtype === WORKFLOW_DOCUMENT_TYPE &&
    typeof value._id === "string" &&
    value._id.startsWith(WORKFLOW_DOCUMENT_ID_PREFIX)
  );
}

function workflowFromDocument(value: unknown): Workflow | null {
  if (!isWorkflowDocument(value) || !isObject(value.body)) return null;

  const body = value.body;
  if (
    body.model !== "quasar.fbp.v1" ||
    typeof body.id !== "string" ||
    value._id !== workflowDocumentId(body.id) ||
    typeof body.version !== "string" ||
    !["workflow", "automation", "actor-system"].includes(String(body.kind)) ||
    typeof body.enabledAtLogin !== "boolean" ||
    !Array.isArray(body.capabilities) ||
    !isObject(body.limits) ||
    !Array.isArray(body.nodes) ||
    !Array.isArray(body.connections) ||
    !Array.isArray(body.iips)
  ) {
    return null;
  }

  return body as unknown as Workflow;
}

async function listDocuments(): Promise<JsonObject[]> {
  const client = getControlPlaneOrThrow();
  const documents: JsonObject[] = [];
  let offset = 0;
  let revision: number | null = null;

  for (let page = 0; page < MAX_DOCUMENT_PAGES; page += 1) {
    const result = await client.send<unknown>("document.list", {
      documentOffset: offset,
      documentByteLimit: DOCUMENT_PAGE_BYTES,
    });

    if (Array.isArray(result)) return result.filter(isObject);
    if (!isObject(result) || !Array.isArray(result.documents)) {
      throw new Error("Control plane returned an invalid document list.");
    }

    documents.push(...result.documents.filter(isObject));
    const pageRevision =
      typeof result.revision === "number" ? result.revision : null;
    if (revision === null) revision = pageRevision;
    else if (pageRevision !== null && pageRevision !== revision) {
      throw new Error("Workspace changed while workflows were loading.");
    }

    const documentPage = result.documentPage;
    if (!isObject(documentPage) || documentPage.complete === true) {
      return documents;
    }

    const nextOffset = Number(documentPage.nextOffset);
    if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
      throw new Error("Control plane returned an invalid document page.");
    }
    offset = nextOffset;
  }

  throw new Error("Workflow document listing exceeded the page limit.");
}

export async function loadWorkflows(): Promise<Workflow[]> {
  const documents = await listDocuments();
  return documents
    .map(workflowFromDocument)
    .filter((workflow): workflow is Workflow => workflow !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function saveWorkflows(workflows: Workflow[]): Promise<void> {
  const client = getControlPlaneOrThrow();
  const existing = (await listDocuments()).filter(isWorkflowDocument);
  const desired = new Map<string, WorkflowDocument>();

  for (const workflow of workflows) {
    const document = workflowDocument(workflow);
    if (desired.has(document._id)) {
      throw new Error(`Duplicate workflow id: ${workflow.id}`);
    }
    desired.set(document._id, document);
  }

  for (const current of existing) {
    const replacement = desired.get(current._id);
    if (!replacement) {
      await client.send("document.delete", { id: current._id });
      continue;
    }
    desired.delete(current._id);
    if (JSON.stringify(current) !== JSON.stringify(replacement)) {
      await client.send("document.update", replacement);
    }
  }

  for (const document of desired.values()) {
    await client.send("document.create", document);
  }
}

export async function loadCatalog(): Promise<NodeDescriptor[]> {
  let local = builtInCatalog;
  try {
    const descriptors = (await getControlPlaneOrThrow().send(
      "fbp.catalog.list",
    )) as NodeDescriptor[];
    if (Array.isArray(descriptors) && descriptors.length) local = descriptors;
  } catch {
    // The editor remains useful in offline/browser-only mode.
  }
  const endpoint = globalThis.localStorage
    ?.getItem("quasar:starintel-endpoint")
    ?.trim();
  if (!endpoint) return local;
  try {
    const response = await fetch(
      `${endpoint.replace(/\/$/, "")}/client-manifest.json`,
      {
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok) return local;
    const manifest = (await response.json()) as {
      operations?: StarIntelOperation[];
      fbp_nodes?: NodeDescriptor[];
    };
    const remote = Array.isArray(manifest.fbp_nodes)
      ? manifest.fbp_nodes.map((descriptor) => ({
          ...descriptor,
          capabilities: descriptor.capabilities || descriptor.scopes || [],
          configSchema:
            descriptor.configSchema || descriptor.config_schema || null,
          operation: (manifest.operations || []).find(
            (operation) =>
              operation.operation_id ===
              (descriptor.operation_id ||
                descriptor.id.replace(/^starintel\.operation\//, "")),
          ),
        }))
      : operationsToNodes(manifest.operations || []);
    return [
      ...local.filter((node) => !node.id.startsWith("starintel.operation/")),
      ...remote,
    ];
  } catch {
    return local;
  }
}

export async function validateRemote(
  workflow: Workflow,
): Promise<Record<string, unknown>> {
  return getControlPlaneOrThrow().send<Record<string, unknown>>(
    "fbp.dsl.validate",
    {
      source: workflowToLisp(workflow),
    },
  );
}

export async function startRemote(
  workflow: Workflow,
): Promise<Record<string, unknown>> {
  return getControlPlaneOrThrow().send<Record<string, unknown>>(
    "fbp.run.start",
    {
      source: workflowToLisp(workflow),
    },
  );
}

export async function stopRemote(id: string): Promise<Record<string, unknown>> {
  return getControlPlaneOrThrow().send<Record<string, unknown>>(
    "fbp.run.stop",
    { id },
  );
}

export async function deploymentPlan(
  workflow: Workflow,
): Promise<Record<string, unknown>> {
  return getControlPlaneOrThrow().send<Record<string, unknown>>(
    "fbp.deployment.plan",
    {
      source: workflowToLisp(workflow),
    },
  );
}

export async function deploy(
  workflow: Workflow,
): Promise<Record<string, unknown>> {
  return getControlPlaneOrThrow().send<Record<string, unknown>>(
    "fbp.deployment.apply",
    {
      source: workflowToLisp(workflow),
    },
  );
}
