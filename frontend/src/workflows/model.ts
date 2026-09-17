export type JsonSchema = Record<string, unknown>;

export interface PortDescriptor {
  name: string;
  schema?: JsonSchema | null;
  required?: boolean;
  array?: boolean;
}

export interface NodeDescriptor {
  id: string;
  label: string;
  category: string;
  inputs: PortDescriptor[];
  outputs: PortDescriptor[];
  capabilities?: unknown[];
  configSchema?: JsonSchema | null;
  config_schema?: JsonSchema | null;
  scopes?: string[];
  operation_id?: string;
  operation?: StarIntelOperation;
}

export interface StarIntelOperation {
  operation_id: string;
  method: string;
  path: string;
  openapi_path?: string;
  summary?: string;
  tags?: string[];
  authority?: string;
  scopes?: string[];
  path_parameters?: string[];
  query_parameters?: Array<{
    name: string;
    required?: boolean;
    schema?: JsonSchema;
  }>;
  request_schema?: JsonSchema | null;
  responses?: Array<{ status: number; schema?: JsonSchema | null }>;
  idempotency?: string | null;
}

export interface WorkflowNode {
  id: string;
  type: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
}

export interface WorkflowConnection {
  id: string;
  from: string;
  out: string;
  to: string;
  in: string;
  capacity: number;
}

export interface WorkflowIip {
  id: string;
  value: unknown;
  to: string;
  in: string;
}

export interface Workflow {
  model: "quasar.fbp.v1";
  id: string;
  version: string;
  kind: "workflow" | "automation" | "actor-system";
  enabledAtLogin: boolean;
  capabilities: unknown[];
  limits: Record<string, number>;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  iips: WorkflowIip[];
}

export const STARINTEL_OPERATION_NODE_TYPE = "starintel/operation";

const STARINTEL_OPERATION_PALETTE_PREFIX = "starintel.operation/";

const unavailableBuiltInNodeTypes = new Set(["starintel/actor", "starintel/domain-server"]);

export const builtInCatalog: NodeDescriptor[] = [
  {
    id: "core/identity",
    label: "Identity",
    category: "Core",
    inputs: [{ name: "in", required: true }],
    outputs: [{ name: "out" }]
  },
  {
    id: "core/split",
    label: "Split array",
    category: "Core",
    inputs: [{ name: "in", required: true, schema: { type: "array" } }],
    outputs: [{ name: "out", array: true }]
  },
  {
    id: "object/build",
    label: "Build object",
    category: "Objects",
    inputs: [{ name: "trigger", required: true }],
    outputs: [{ name: "object", schema: { type: "object" } }]
  },
  {
    id: STARINTEL_OPERATION_NODE_TYPE,
    label: "StarIntel API operation",
    category: "StarIntel API",
    inputs: [{ name: "request", required: true }],
    outputs: [
      { name: "result", schema: { type: "object" } },
      { name: "error", schema: { type: "object" } }
    ]
  },
  {
    id: "language/lisp",
    label: "Trusted Lisp component",
    category: "Languages",
    inputs: [{ name: "in", required: true }],
    outputs: [{ name: "out" }]
  },
  {
    id: "language/star",
    label: "Star Language",
    category: "Languages",
    inputs: [{ name: "in", required: true }],
    outputs: [{ name: "out" }]
  },
  {
    id: "process/exec",
    label: "Sandboxed process",
    category: "Languages",
    inputs: [{ name: "stdin", required: true, schema: { type: "string" } }],
    outputs: [
      { name: "stdout", schema: { type: "string" } },
      { name: "status", schema: { type: "integer" } }
    ]
  }
];

export function emptyWorkflow(id = "new-workflow"): Workflow {
  return {
    model: "quasar.fbp.v1",
    id,
    version: "1",
    kind: "workflow",
    enabledAtLogin: false,
    capabilities: [],
    limits: { packets: 100000, bytes: 67108864, seconds: 3600, concurrency: 4 },
    nodes: [],
    connections: [],
    iips: []
  };
}

export function operationIdForDescriptor(descriptor: NodeDescriptor): string | null {
  if (descriptor.operation?.operation_id) return descriptor.operation.operation_id;
  if (descriptor.id.startsWith(STARINTEL_OPERATION_PALETTE_PREFIX))
    return descriptor.id.slice(STARINTEL_OPERATION_PALETTE_PREFIX.length);
  if (descriptor.operation_id) return descriptor.operation_id;
  const properties = (descriptor.configSchema || descriptor.config_schema)?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  const operation = (properties as Record<string, unknown>).operation;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return null;
  const value = (operation as Record<string, unknown>).const;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function workflowNodeFromDescriptor(
  descriptor: NodeDescriptor,
  id: string,
  x: number,
  y: number
): WorkflowNode {
  const operation = operationIdForDescriptor(descriptor);
  return {
    id,
    type: descriptor.id,
    x,
    y,
    config: operation
      ? {
          operation,
          credential_reference: "credential:starintel-api"
        }
      : {}
  };
}

export function descriptorForWorkflowNode(
  node: WorkflowNode,
  descriptors: ReadonlyMap<string, NodeDescriptor>
): NodeDescriptor | undefined {
  return descriptors.get(node.type);
}

export function advertisedCatalog(catalog: NodeDescriptor[]): NodeDescriptor[] {
  return catalog.filter((descriptor) => !unavailableBuiltInNodeTypes.has(descriptor.id));
}

export function operationsToNodes(operations: StarIntelOperation[]): NodeDescriptor[] {
  return operations.map((operation) => {
    const properties =
      operation.request_schema?.properties &&
      typeof operation.request_schema.properties === "object" &&
      !Array.isArray(operation.request_schema.properties)
        ? (operation.request_schema.properties as Record<string, JsonSchema>)
        : {};
    const required = new Set(
      Array.isArray(operation.request_schema?.required)
        ? (operation.request_schema.required as string[])
        : []
    );
    const inputs: PortDescriptor[] = Object.entries(properties).map(([name, schema]) => ({
      name,
      schema,
      required: required.has(name)
    }));
    for (const name of operation.path_parameters || []) {
      inputs.push({ name, required: true, schema: { type: "string" } });
    }
    for (const parameter of operation.query_parameters || []) {
      inputs.push({
        name: parameter.name,
        required: parameter.required === true,
        schema: parameter.schema
      });
    }
    if (!inputs.length) {
      inputs.push({ name: "trigger", required: true, schema: { type: "object" } });
    }
    return {
      id: `starintel.operation/${operation.operation_id}`,
      label: operation.summary || operation.operation_id,
      category: operation.tags?.[0] ? `StarIntel · ${operation.tags[0]}` : "StarIntel API",
      inputs,
      outputs: (operation.responses || [])
        .filter(({ status }) => status >= 200 && status < 300)
        .map(({ status, schema }) => ({
          name: `status-${status}`,
          schema: schema || { type: "object" }
        })),
      capabilities: operation.scopes || [],
      configSchema: {
        type: "object",
        properties: {
          operation: { const: operation.operation_id },
          credential_reference: {
            type: "string",
            pattern: "^credential:[A-Za-z0-9_.-]+$"
          }
        }
      },
      operation
    };
  });
}

function schemaType(port?: PortDescriptor): string {
  return String(port?.schema?.type || "any");
}

export function portsCompatible(output?: PortDescriptor, input?: PortDescriptor): boolean {
  const from = schemaType(output);
  const to = schemaType(input);
  return from === "any" || to === "any" || from === to;
}

export function validateWorkflow(workflow: Workflow, catalog: NodeDescriptor[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const descriptor = new Map(catalog.map((entry) => [entry.id, entry]));
  const incoming = new Map<string, string>();
  const iipIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) errors.push(`Duplicate node ${node.id}`);
    ids.add(node.id);
    if (!descriptor.has(node.type)) errors.push(`Unknown node type ${node.type}`);
    if (
      (node.type === STARINTEL_OPERATION_NODE_TYPE ||
        node.type.startsWith(STARINTEL_OPERATION_PALETTE_PREFIX)) &&
      (typeof node.config.operation !== "string" || !node.config.operation)
    )
      errors.push(`StarIntel operation node ${node.id} has no operation id`);
  }
  for (const edge of workflow.connections) {
    const from = workflow.nodes.find((node) => node.id === edge.from);
    const to = workflow.nodes.find((node) => node.id === edge.to);
    const fromPort = descriptor
      .get(from?.type || "")
      ?.outputs.find((port) => port.name === edge.out);
    const toPort = descriptor.get(to?.type || "")?.inputs.find((port) => port.name === edge.in);
    if (!from || !to || !fromPort || !toPort) errors.push(`Invalid connection ${edge.id}`);
    else if (!portsCompatible(fromPort, toPort)) errors.push(`Incompatible ports on ${edge.id}`);
    if (edge.capacity < 1) errors.push(`Connection ${edge.id} has invalid capacity`);
    const key = `${edge.to}:${edge.in}`;
    if (incoming.has(key)) errors.push(`Input ${key} has multiple producers`);
    incoming.set(key, "connection");
  }
  for (const iip of workflow.iips) {
    const key = `${iip.to}:${iip.in}`;
    if (iipIds.has(iip.id)) errors.push(`Duplicate initial packet ${iip.id}`);
    iipIds.add(iip.id);
    const target = workflow.nodes.find((node) => node.id === iip.to);
    const input = descriptor.get(target?.type || "")?.inputs.find((port) => port.name === iip.in);
    if (!target || !input) {
      errors.push(`Invalid initial packet ${iip.id}`);
      continue;
    }
    if (incoming.has(key)) errors.push(`Input ${key} has multiple producers`);
    incoming.set(key, "initial packet");
  }
  for (const node of workflow.nodes) {
    for (const port of descriptor.get(node.type)?.inputs || []) {
      if (port.required && !incoming.has(`${node.id}:${port.name}`)) {
        errors.push(`Required input ${node.id}.${port.name} is not connected`);
      }
    }
  }
  return errors;
}

export function renameWorkflowNode(
  workflow: Workflow,
  previousId: string,
  nextId: string
): Workflow {
  const node = workflow.nodes.find((candidate) => candidate.id === previousId);
  if (!node || previousId === nextId) return workflow;
  if (!nextId.trim()) throw new Error("Node id cannot be empty");
  if (workflow.nodes.some((candidate) => candidate.id === nextId)) {
    throw new Error(`Duplicate node ${nextId}`);
  }
  node.id = nextId;
  for (const edge of workflow.connections) {
    if (edge.from === previousId) edge.from = nextId;
    if (edge.to === previousId) edge.to = nextId;
    edge.id = `${edge.from}:${edge.out}->${edge.to}:${edge.in}`;
  }
  for (const iip of workflow.iips) {
    if (iip.to === previousId) {
      iip.to = nextId;
      iip.id = `${nextId}:${iip.in}:iip`;
    }
  }
  return workflow;
}

export function removeWorkflowNode(workflow: Workflow, id: string): Workflow {
  workflow.nodes = workflow.nodes.filter((node) => node.id !== id);
  workflow.connections = workflow.connections.filter((edge) => edge.from !== id && edge.to !== id);
  workflow.iips = workflow.iips.filter((iip) => iip.to !== id);
  return workflow;
}

export function connectWorkflowInput(
  workflow: Workflow,
  from: string,
  out: string,
  to: string,
  input: string,
  capacity = 16
): Workflow {
  workflow.connections = workflow.connections.filter(
    (edge) => !(edge.to === to && edge.in === input)
  );
  workflow.iips = workflow.iips.filter((iip) => !(iip.to === to && iip.in === input));
  workflow.connections.push({
    id: `${from}:${out}->${to}:${input}`,
    from,
    out,
    to,
    in: input,
    capacity
  });
  return workflow;
}

function lispString(value: string): string {
  return JSON.stringify(value);
}

function lispLiteral(value: unknown): string {
  if (value === null || value === undefined || value === false) return "nil";
  if (value === true) return "t";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return lispString(value);
  if (Array.isArray(value)) return `(${value.map(lispLiteral).join(" ")})`;
  if (typeof value === "object") {
    return `(${Object.entries(value as Record<string, unknown>)
      .flatMap(([key, item]) => [
        `:${key
          .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
          .replaceAll("_", "-")
          .toLowerCase()}`,
        lispLiteral(item)
      ])
      .join(" ")})`;
  }
  throw new Error(`Unsupported value: ${typeof value}`);
}

export function workflowToLisp(workflow: Workflow): string {
  const options = [
    ":version",
    lispString(workflow.version),
    ":kind",
    `:${workflow.kind}`,
    ":enabled-at-login",
    workflow.enabledAtLogin ? "t" : "nil",
    ":capabilities",
    lispLiteral(workflow.capabilities),
    ":limits",
    lispLiteral(workflow.limits)
  ].join(" ");
  const components = workflow.nodes.map(
    (node) =>
      `  (:component ${lispString(node.id)} ${lispString(node.type)} :config ${lispLiteral(node.config)})`
  );
  const connections = workflow.connections.map(
    (edge) =>
      `  (:connect ${lispString(edge.from)} ${lispString(edge.out)} ${lispString(edge.to)} ${lispString(edge.in)} :capacity ${edge.capacity})`
  );
  const iips = workflow.iips.map(
    (iip) => `  (:iip ${lispLiteral(iip.value)} ${lispString(iip.to)} ${lispString(iip.in)})`
  );
  return `(define-network ${workflow.id.replaceAll(/[^A-Za-z0-9_-]/g, "-")}\n  (${options})\n${[
    ...components,
    ...connections,
    ...iips
  ].join("\n")})\n`;
}
