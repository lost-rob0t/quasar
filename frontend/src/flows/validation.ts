import { registry } from "./catalog";
import {
  isJson,
  isObject,
  jsonBytes,
  jsonClone,
  LIMITS,
  type Flow,
  type Diagnostic,
  type Config
} from "./model";
const identifier = /^[a-zA-Z0-9_.:-]{1,80}$/;
const operators = ["eq", "neq", "gt", "gte", "lt", "lte", "exists", "contains"];
const string = (value: unknown): value is string => typeof value === "string";
function configError(type: string, config: Config): string | null {
  if (
    ["map", "filter", "switch", "dedup", "starintel.field"].includes(type) &&
    !string(config.path)
  )
    return "path must be a string";
  if (["filter", "switch"].includes(type) && !operators.includes(String(config.operator)))
    return "Unknown predicate operator";
  if (
    type === "map" &&
    !["identity", "get", "add", "multiply", "wrap"].includes(String(config.operation))
  )
    return "Unknown map operation";
  if (
    type === "map" &&
    ["add", "multiply"].includes(String(config.operation)) &&
    typeof config.value !== "number"
  )
    return "Numeric map value required";
  if (
    type === "change" &&
    (!string(config.field) ||
      !config.field ||
      ["__proto__", "constructor", "prototype"].includes(config.field))
  )
    return "Safe top-level field required";
  if (
    ["join", "take"].includes(type) &&
    (!Number.isInteger(config.count) ||
      Number(config.count) < 1 ||
      Number(config.count) > LIMITS.messages)
  )
    return "count must be 1–2048";
  if (
    type === "delay" &&
    (!Number.isInteger(config.milliseconds) ||
      Number(config.milliseconds) < 0 ||
      Number(config.milliseconds) > 1000)
  )
    return "milliseconds must be 0–1000";
  if (type.startsWith("code.") && (!string(config.source) || !config.source.trim()))
    return "Source is required";
  if (
    type.startsWith("transport.") &&
    (!string(config.connectionRef) || !config.connectionRef.trim())
  )
    return "A host connectionRef is required";
  if (
    (type.startsWith("transport.") ||
      ["starintel.search", "starintel.actor", "starintel.target"].includes(type)) &&
    Object.keys(config).some((key) => /password|token|secret|credential|url/i.test(key))
  )
    return "Inline credentials and URLs are forbidden; use connectionRef";
  return null;
}
export function validateFlow(value: unknown): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const add = (code: string, message: string, nodeId?: string, edgeId?: string) =>
    errors.push({ code, message, nodeId, edgeId });
  if (!isJson(value) || !isObject(value))
    return [{ code: "shape", message: "Flow must be safe finite JSON (maximum nesting 32)." }];
  if (jsonBytes(value) > LIMITS.bytes) add("budget", "Flow exceeds 1 MiB");
  if (
    value.version !== 1 ||
    !string(value.name) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  )
    return [{ code: "version", message: "Expected version 1, name, nodes and edges." }];
  if (value.nodes.length > LIMITS.nodes || value.edges.length > LIMITS.edges)
    add("budget", "Flow exceeds 128 nodes or 512 edges");
  const nodes = new Map<string, { type: string }>();
  for (const node of value.nodes) {
    if (
      !isObject(node) ||
      !string(node.id) ||
      !identifier.test(node.id) ||
      !string(node.type) ||
      !string(node.label) ||
      !isObject(node.config) ||
      !Number.isFinite(node.x) ||
      !Number.isFinite(node.y) ||
      Number(node.x) < 0 ||
      Number(node.x) > 5000 ||
      Number(node.y) < 0 ||
      Number(node.y) > 5000
    ) {
      add("node-shape", "Invalid node shape");
      continue;
    }
    if (nodes.has(node.id)) add("duplicate", "Duplicate node ID", node.id);
    nodes.set(node.id, { type: node.type });
    const def = registry.get(node.type);
    if (!def) add("unknown-node", `Unsupported node type ${node.type}`, node.id);
    else {
      const failure = configError(node.type, node.config as Config);
      if (failure) add("config", failure, node.id);
    }
  }
  const ids = new Set<string>();
  const wires = new Set<string>();
  const links = new Map<string, string[]>();
  for (const edge of value.edges) {
    if (
      !isObject(edge) ||
      !string(edge.id) ||
      !identifier.test(edge.id) ||
      !isObject(edge.from) ||
      !isObject(edge.to) ||
      !string(edge.from.node) ||
      !string(edge.to.node) ||
      !string(edge.from.port) ||
      !string(edge.to.port)
    ) {
      add("edge-shape", "Invalid edge shape");
      continue;
    }
    if (ids.has(edge.id)) add("duplicate", "Duplicate edge ID", undefined, edge.id);
    ids.add(edge.id);
    const signature = JSON.stringify([edge.from, edge.to]);
    if (wires.has(signature)) add("duplicate-wire", "Duplicate connection", undefined, edge.id);
    wires.add(signature);
    const source = nodes.get(edge.from.node);
    const target = nodes.get(edge.to.node);
    if (!source || !target) {
      add("dangling", "Missing endpoint node", undefined, edge.id);
      continue;
    }
    const out = registry.get(source.type)?.outputs[edge.from.port];
    const input = registry.get(target.type)?.inputs[edge.to.port];
    if (!out || !input) add("port", "Unknown input or output port", undefined, edge.id);
    else if (input !== "json" && out !== "json" && input !== out)
      add("type", `Cannot wire ${out} to ${input}`, undefined, edge.id);
    links.set(edge.from.node, [...(links.get(edge.from.node) || []), edge.to.node]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of links.get(id) || []) if (visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  if (value.nodes.length <= LIMITS.nodes && [...nodes.keys()].some(visit))
    add("cycle", "Preview supports acyclic flows only");
  return errors;
}
export function parseFlow(text: string): Flow {
  if (new TextEncoder().encode(text).length > LIMITS.bytes) throw new Error("Flow exceeds 1 MiB");
  const value: unknown = JSON.parse(text);
  const errors = validateFlow(value);
  if (errors.length)
    throw new Error(
      errors
        .map((error) => `${error.nodeId || error.edgeId || error.code}: ${error.message}`)
        .join("\n")
    );
  return jsonClone(value) as Flow;
}
export function serializeFlow(flow: Flow): string {
  return JSON.stringify(parseFlow(JSON.stringify(flow)), null, 2);
}
export function exampleFlow(): Flow {
  return {
    version: 1,
    name: "Map and filter preview",
    nodes: [
      {
        id: "input",
        type: "inject",
        label: "Numbers",
        x: 30,
        y: 50,
        config: { payload: [1, 2, 3, 4] }
      },
      {
        id: "double",
        type: "map",
        label: "Multiply by 2",
        x: 290,
        y: 50,
        config: { operation: "multiply", path: "", value: 2 }
      },
      {
        id: "select",
        type: "filter",
        label: "Keep ≥ 5",
        x: 550,
        y: 50,
        config: { operator: "gte", path: "", value: 5 }
      },
      { id: "output", type: "debug", label: "Results", x: 810, y: 50, config: {} }
    ],
    edges: [
      { id: "e1", from: { node: "input", port: "out" }, to: { node: "double", port: "in" } },
      { id: "e2", from: { node: "double", port: "out" }, to: { node: "select", port: "in" } },
      { id: "e3", from: { node: "select", port: "out" }, to: { node: "output", port: "in" } }
    ]
  };
}
