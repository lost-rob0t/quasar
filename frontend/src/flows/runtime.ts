import { registry } from "./catalog";
import { validateFlow } from "./validation";
import {
  isJson,
  isObject,
  jsonBytes,
  jsonClone,
  LIMITS,
  readPath,
  type Config,
  type Flow,
  type FlowNode,
  type Json,
  type PortType
} from "./model";
export interface AdapterContext {
  node: FlowNode;
  payload: Json;
  signal: AbortSignal;
}
export type Adapter = (context: AdapterContext) => Promise<Json>;
export interface RunOptions {
  adapters?: Record<string, Adapter>;
  grants?: readonly string[];
  validateDocument?: (value: Json) => void;
  signal?: AbortSignal;
  limits?: Partial<{ messages: number; steps: number; payloadBytes: number; timeoutMs: number }>;
}
export interface TraceEntry {
  nodeId: string;
  port: string;
  payload: Json;
  kind: "output" | "debug" | "error";
}
export interface RunResult {
  status: "completed" | "failed" | "cancelled";
  trace: TraceEntry[];
  steps: number;
  error?: string;
}
function predicate(payload: Json, config: Config): boolean {
  const value = readPath(payload, String(config.path));
  const expected = config.value;
  switch (config.operator) {
    case "exists":
      return value !== null;
    case "eq":
      return JSON.stringify(value) === JSON.stringify(expected);
    case "neq":
      return JSON.stringify(value) !== JSON.stringify(expected);
    case "contains":
      return typeof value === "string" && typeof expected === "string" && value.includes(expected);
    case "gt":
      return typeof value === "number" && typeof expected === "number" && value > expected;
    case "gte":
      return typeof value === "number" && typeof expected === "number" && value >= expected;
    case "lt":
      return typeof value === "number" && typeof expected === "number" && value < expected;
    case "lte":
      return typeof value === "number" && typeof expected === "number" && value <= expected;
    default:
      throw new Error("Unknown predicate");
  }
}
function assertType(
  payload: Json,
  type: PortType,
  validateDocument?: RunOptions["validateDocument"]
) {
  if (type === "array" && !Array.isArray(payload)) throw new Error("Expected array payload");
  if (type === "string" && typeof payload !== "string") throw new Error("Expected string payload");
  if (type === "document") {
    if (!validateDocument) throw new Error("Canonical StarIntel validator unavailable");
    validateDocument(payload);
  }
}
// Trusted adapters must honor AbortSignal and bound their own work. The runtime
// cancels and stops routing on timeout; it cannot kill an arbitrary host process.
export async function runFlow(flow: Flow, options: RunOptions = {}): Promise<RunResult> {
  const trace: TraceEntry[] = [];
  let steps = 0;
  const errors = validateFlow(flow);
  if (errors.length)
    return { status: "failed", trace, steps, error: errors.map((e) => e.message).join("; ") };
  flow = jsonClone(flow);
  const limits: Record<"messages" | "steps" | "payloadBytes" | "timeoutMs", number> = {
    messages: LIMITS.messages,
    steps: LIMITS.steps,
    payloadBytes: LIMITS.payloadBytes,
    timeoutMs: LIMITS.timeoutMs
  };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = options.limits?.[key];
    if (value !== undefined) {
      if (!Number.isInteger(value) || value < 1 || value > limits[key])
        return { status: "failed", trace, steps, error: `Invalid ${key} limit` };
      limits[key] = value;
    }
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason || new Error("Preview cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new Error("Preview time budget exceeded")),
    limits.timeoutMs
  );
  const signal = controller.signal;
  const cancelled = () => {
    if (signal.aborted) throw signal.reason || new Error("Preview cancelled");
  };
  const awaitBounded = <T>(work: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const fail = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => signal.removeEventListener("abort", fail);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
      work.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        }
      );
    });
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const queue: { node: string; port: string; payload: Json }[] = [];
  const state = new Map<
    string,
    { items: Json[]; left: Json[][]; right: Json[][]; seen: Set<string>; count: number }
  >();
  let messages = 0;
  let retainedBytes = 0;
  const reserve = (payload: Json) => {
    if (!isJson(payload)) throw new Error("Expected safe finite JSON payload");
    const size = jsonBytes(payload);
    if (size > limits.payloadBytes) throw new Error("Payload byte budget exceeded");
    retainedBytes += size;
    // Includes retained trace, queue and state; bound the entire preview, not just each message.
    if (retainedBytes > LIMITS.bytes * 4) throw new Error("Preview retained-byte budget exceeded");
  };
  const emit = (
    nodeId: string,
    port: string,
    payload: Json,
    kind: TraceEntry["kind"] = "output"
  ) => {
    cancelled();
    if (++messages > limits.messages) throw new Error("Message budget exceeded");
    reserve(payload);
    const node = nodes.get(nodeId)!;
    assertType(payload, registry.get(node.type)!.outputs[port], options.validateDocument);
    trace.push({ nodeId, port, payload: jsonClone(payload), kind });
    for (const edge of flow.edges.filter(
      (edge) => edge.from.node === nodeId && edge.from.port === port
    )) {
      reserve(payload);
      if (queue.length >= limits.messages) throw new Error("Queue budget exceeded");
      queue.push({ node: edge.to.node, port: edge.to.port, payload: jsonClone(payload) });
    }
  };
  try {
    cancelled();
    for (const node of flow.nodes) {
      const adapter = registry.get(node.type)!.adapter;
      if (
        adapter &&
        (!options.grants?.includes(adapter) || typeof options.adapters?.[adapter] !== "function")
      )
        throw new Error(
          `${node.label}: adapter ${adapter} is disabled; trusted adapter and explicit grant required`
        );
    }
    for (const node of flow.nodes.filter((node) => node.type === "inject"))
      emit(node.id, "out", node.config.payload ?? null);
    while (queue.length) {
      cancelled();
      if (++steps > limits.steps) throw new Error("Step budget exceeded");
      const message = queue.shift()!;
      const node = nodes.get(message.node)!;
      const def = registry.get(node.type)!;
      const config = node.config;
      const payload = message.payload;
      const local = state.get(node.id) || {
        items: [],
        left: [],
        right: [],
        seen: new Set<string>(),
        count: 0
      };
      state.set(node.id, local);
      const output = (value: Json, port = "out") => emit(node.id, port, value);
      try {
        assertType(payload, def.inputs[message.port], options.validateDocument);
        if (def.adapter) {
          const result = await awaitBounded(
            options.adapters![def.adapter]({
              node: jsonClone(node),
              payload: jsonClone(payload),
              signal
            })
          );
          output(result);
          continue;
        }
        switch (node.type) {
          case "debug":
            reserve(payload);
            trace.push({ nodeId: node.id, port: "in", payload: jsonClone(payload), kind: "debug" });
            break;
          case "merge":
            output(payload);
            break;
          case "map":
            output(
              (payload as Json[]).map((item) => {
                switch (config.operation) {
                  case "identity":
                    return item;
                  case "get":
                    return readPath(item, String(config.path));
                  case "wrap":
                    return { value: item };
                  default: {
                    if (typeof item !== "number") throw new Error("Numeric map requires numbers");
                    return config.operation === "add"
                      ? item + Number(config.value)
                      : item * Number(config.value);
                  }
                }
              })
            );
            break;
          case "filter":
            if (Array.isArray(payload)) output(payload.filter((item) => predicate(item, config)));
            else if (predicate(payload, config)) output(payload);
            break;
          case "switch":
            output(payload, predicate(payload, config) ? "match" : "otherwise");
            break;
          case "change":
            if (!isObject(payload)) throw new Error("Change requires an object");
            output({ ...payload, [String(config.field)]: config.value ?? null } as Json);
            break;
          case "split":
            for (const item of payload as Json[]) output(item);
            break;
          case "join":
            local.items.push(payload);
            if (local.items.length === config.count) {
              output(local.items);
              local.items = [];
            }
            break;
          case "concat":
            local[message.port as "left" | "right"].push(payload as Json[]);
            if (local.left.length && local.right.length)
              output([...local.left.shift()!, ...local.right.shift()!]);
            break;
          case "dedup": {
            const key = JSON.stringify(readPath(payload, String(config.path)));
            if (!local.seen.has(key)) {
              local.seen.add(key);
              output(payload);
            }
            break;
          }
          case "take":
            if (local.count++ < Number(config.count)) output(payload);
            break;
          case "delay":
            await awaitBounded(
              new Promise<void>((resolve) => {
                const finish = () => {
                  clearTimeout(delayTimer);
                  signal.removeEventListener("abort", finish);
                  resolve();
                };
                const delayTimer = setTimeout(finish, Number(config.milliseconds));
                signal.addEventListener("abort", finish, { once: true });
              })
            );
            output(payload);
            break;
          case "json.parse":
            output(JSON.parse(payload as string) as Json);
            break;
          case "json.stringify":
            output(JSON.stringify(payload));
            break;
          case "starintel.validate":
            assertType(payload, "document", options.validateDocument);
            output(payload);
            break;
          case "starintel.field":
            output(readPath(payload, String(config.path)));
            break;
          default:
            throw new Error(`No implementation for ${node.type}`);
        }
      } catch (error) {
        cancelled();
        if (!flow.edges.some((edge) => edge.from.node === node.id && edge.from.port === "error"))
          throw new Error(
            `${node.label}: ${error instanceof Error ? error.message : String(error)}`
          );
        emit(
          node.id,
          "error",
          { nodeId: node.id, message: error instanceof Error ? error.message : String(error) },
          "error"
        );
      }
    }
    for (const [id, local] of state)
      if (local.items.length || local.left.length || local.right.length)
        throw new Error(`${id}: incomplete join or concat inputs`);
    return { status: "completed", trace, steps };
  } catch (error) {
    return {
      status: options.signal?.aborted ? "cancelled" : "failed",
      trace,
      steps,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
