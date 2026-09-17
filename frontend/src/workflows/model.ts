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
  operation?: StarIntelOperation;
}

export interface StarIntelOperation {
  operation_id: string;
  method: string;
  path: string;
  summary?: string;
  tags?: string[];
  authority?: string;
  scopes?: string[];
  path_parameters?: string[];
  query_parameters?: Array<{ name: string; required?: boolean; schema?: JsonSchema }>;
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
    id: "starintel/target",
    label: "Submit target",
    category: "Targets",
    inputs: [{ name: "target", required: true, schema: { type: "object" } }],
    outputs: [{ name: "receipt", schema: { type: "object" } }]
  },
  {
    id: "starintel/actor",
    label: "Actor message",
    category: "Actors",
    inputs: [{ name: "message", required: true }],
    outputs: [{ name: "result" }]
  },
  {
    id: "starintel/domain-server",
    label: "Domain server",
    category: "Domain servers",
    inputs: [{ name: "request", required: true }],
    outputs: [{ name: "result" }]
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

function schemaPorts(schema: JsonSchema | null | undefined): PortDescriptor[] {
  if (!schema || schema.type !== "object") return [{ name: "request", required: Boolean(schema) }];
  const properties = (schema.properties || {}) as Record<string, JsonSchema>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(properties).map(([name, value]) => ({
    name,
    schema: value,
    required: required.has(name)
  }));
}

export function operationsToNodes(operations: StarIntelOperation[]): NodeDescriptor[] {
  return operations.map((operation) => ({
    id: `starintel.operation/${operation.operation_id}`,
    label: operation.summary || operation.operation_id,
    category: operation.tags?.[0] ? `StarIntel · ${operation.tags[0]}` : "StarIntel API",
    inputs: [
      ...schemaPorts(operation.request_schema),
      ...(operation.path_parameters || []).map((name) => ({ name, required: true })),
      ...(operation.query_parameters || []).map((parameter) => ({
        name: parameter.name,
        required: Boolean(parameter.required),
        schema: parameter.schema
      }))
    ],
    outputs: (operation.responses || [])
      .filter((response) => response.status >= 200 && response.status < 300)
      .map((response) => ({ name: `status-${response.status}`, schema: response.schema })),
    capabilities: operation.scopes || [],
    configSchema: {
      type: "object",
      properties: {
        operation: { const: operation.operation_id },
        credentialReference: { type: "string", pattern: "^credential:[A-Za-z0-9_.-]+$" }
      }
    },
    operation
  }));
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
  const incoming = new Set<string>();
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) errors.push(`Duplicate node ${node.id}`);
    ids.add(node.id);
    if (!descriptor.has(node.type)) errors.push(`Unknown node type ${node.type}`);
  }
  for (const edge of workflow.connections) {
    const from = workflow.nodes.find((node) => node.id === edge.from);
    const to = workflow.nodes.find((node) => node.id === edge.to);
    const fromPort = descriptor.get(from?.type || "")?.outputs.find((port) => port.name === edge.out);
    const toPort = descriptor.get(to?.type || "")?.inputs.find((port) => port.name === edge.in);
    if (!from || !to || !fromPort || !toPort) errors.push(`Invalid connection ${edge.id}`);
    else if (!portsCompatible(fromPort, toPort)) errors.push(`Incompatible ports on ${edge.id}`);
    if (edge.capacity < 1) errors.push(`Connection ${edge.id} has invalid capacity`);
    const key = `${edge.to}:${edge.in}`;
    if (incoming.has(key)) errors.push(`Input ${key} has multiple producers`);
    incoming.add(key);
  }
  for (const iip of workflow.iips) {
    const key = `${iip.to}:${iip.in}`;
    if (incoming.has(key)) errors.push(`Input ${key} has both a connection and IIP`);
    incoming.add(key);
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
      .flatMap(([key, item]) => [`:${key.replaceAll("_", "-")}`, lispLiteral(item)])
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
    (node) => `  (:component ${lispString(node.id)} ${lispString(node.type)} :config ${lispLiteral(node.config)})`
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
