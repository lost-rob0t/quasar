import { assertDocument } from "../lib/canonical-document";
import { createOpaqueOriginBrowserActorRuntime } from "../lib/opaque-origin-actor-runtime";
import { isJson, type Json } from "./model";
import type { Adapter } from "./runtime";
export { CATALOG, registry } from "./catalog";
export { exampleFlow, parseFlow, serializeFlow, validateFlow } from "./validation";
export { runFlow } from "./runtime";
export type { Flow, FlowNode, FlowEdge, Json } from "./model";
export type { RunResult } from "./runtime";
export function validateCanonicalDocument(value: Json): void {
  assertDocument(value);
}
export function isolatedJavaScriptAdapter(): Adapter {
  const runtime = createOpaqueOriginBrowserActorRuntime();
  return async ({ node, payload, signal }) => {
    // User source is evaluated only inside the existing opaque-origin sandbox.
    // No workspace, transport, or document capabilities are granted.
    const result = await runtime.run(
      {
        id: `flow-${node.id}`,
        label: node.label,
        minSelection: 0,
        maxSelection: 0,
        capabilities: [],
        limits: { timeoutMs: 2000, maxResultBytes: 262144 },
        source: `async (context) => {
        const transform = (${String(node.config.source)});
        if (typeof transform !== "function") throw new Error("Source must be a function");
        const payload = await transform(context.flowPayload);
        if (payload === undefined) throw new Error("Return a JSON payload");
        return { metrics: { flowPayload: payload } };
      }`
      },
      { flowPayload: payload, selection: [], documents: [] },
      { signal, timeoutMs: 2000 }
    );
    const output: unknown = result.metrics.flowPayload;
    if (!isJson(output)) throw new Error("JavaScript must return safe finite JSON");
    return output;
  };
}
