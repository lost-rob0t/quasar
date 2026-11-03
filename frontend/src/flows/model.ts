export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type PortType = "json" | "array" | "string" | "document";
export type Config = { [key: string]: Json };
export interface FlowNode {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  config: Config;
}
export interface Endpoint {
  node: string;
  port: string;
}
export interface FlowEdge {
  id: string;
  from: Endpoint;
  to: Endpoint;
}
export interface Flow {
  version: 1;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}
export interface Definition {
  type: string;
  label: string;
  category: string;
  inputs: Record<string, PortType>;
  outputs: Record<string, PortType>;
  defaults: Config;
  adapter?: string;
  help: string;
}
export interface Diagnostic {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}
export const LIMITS = Object.freeze({
  nodes: 128,
  edges: 512,
  bytes: 1_048_576,
  messages: 2048,
  payloadBytes: 262144,
  steps: 4096,
  timeoutMs: 10000
});
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  return (
    isObject(value) &&
    Object.entries(value).every(
      ([key, item]) =>
        !["__proto__", "prototype", "constructor"].includes(key) && isJson(item, depth + 1)
    )
  );
}
export function readPath(value: Json, path: string): Json {
  if (!path) return value;
  let current: Json = value;
  for (const part of path.split(".")) {
    if (["__proto__", "prototype", "constructor"].includes(part))
      throw new Error("Unsafe property path");
    if (!isObject(current) || !Object.hasOwn(current, part)) return null;
    current = current[part] as Json;
  }
  return current;
}
