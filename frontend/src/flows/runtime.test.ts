import { describe, expect, it, vi } from "vitest";
import { CATALOG, registry } from "./catalog";
import { exampleFlow, parseFlow, serializeFlow, validateFlow } from "./validation";
import { runFlow, type RunOptions } from "./runtime";
import type { Config, Flow, FlowNode, Json } from "./model";
const node = (id: string, type: string, config: Config = {}): FlowNode => ({
  id,
  type,
  label: id,
  x: 0,
  y: 0,
  config: { ...registry.get(type)!.defaults, ...config }
});
const edge = (from: string, to: string, port = "out", input = "in") => ({
  id: `${from}-${port}-${to}-${input}`,
  from: { node: from, port },
  to: { node: to, port: input }
});
function pipeline(type: string, payload: Json, config: Config = {}): Flow {
  return {
    version: 1,
    name: "test",
    nodes: [
      node("source", "inject", { payload }),
      node("transform", type, config),
      node("sink", "debug")
    ],
    edges: [edge("source", "transform"), edge("transform", "sink")]
  };
}
async function output(flow: Flow, options: RunOptions = {}) {
  const result = await runFlow(flow, options);
  expect(result.status, result.error).toBe("completed");
  return result.trace.filter((entry) => entry.kind === "debug").map((entry) => entry.payload);
}
describe("flow serialization and validation", () => {
  it("round trips position, configuration and named ports without mutation", () => {
    const flow = exampleFlow();
    const serialized = serializeFlow(flow);
    const parsed = parseFlow(serialized);
    expect(parsed).toEqual(flow);
    parsed.nodes[0].config.payload = null;
    expect(flow.nodes[0].config.payload).not.toBeNull();
  });
  it.each([
    ["version", (flow: Flow) => ({ ...flow, version: 2 })],
    [
      "unknown-node",
      (flow: Flow) => ({
        ...flow,
        nodes: [...flow.nodes, { ...node("bad", "debug"), type: "unregistered" }]
      })
    ],
    ["duplicate", (flow: Flow) => ({ ...flow, nodes: [...flow.nodes, flow.nodes[0]] })],
    ["dangling", (flow: Flow) => ({ ...flow, edges: [...flow.edges, edge("missing", "output")] })],
    [
      "port",
      (flow: Flow) => ({ ...flow, edges: [...flow.edges, edge("input", "output", "missing")] })
    ],
    ["cycle", (flow: Flow) => ({ ...flow, edges: [...flow.edges, edge("select", "double")] })],
    [
      "duplicate-wire",
      (flow: Flow) => ({ ...flow, edges: [...flow.edges, { ...flow.edges[0], id: "another" }] })
    ]
  ])("rejects %s", (code, change) => {
    expect(validateFlow(change(exampleFlow())).some((e) => e.code === code)).toBe(true);
  });
  it("rejects incompatible declared types", () => {
    const flow: Flow = {
      version: 1,
      name: "types",
      nodes: [node("a", "json.stringify"), node("b", "map")],
      edges: [edge("a", "b")]
    };
    expect(validateFlow(flow).some((e) => e.code === "type")).toBe(true);
  });
  it("allows dynamic JSON ports and checks the actual value before delivery", async () => {
    const result = await runFlow(pipeline("map", "wrong"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Expected array");
  });
  it("rejects prototype keys, invalid configuration, and oversized imports", () => {
    expect(() =>
      parseFlow('{"version":1,"name":"unsafe","nodes":[],"edges":[],"__proto__":{}}')
    ).toThrow("safe finite JSON");
    expect(validateFlow(pipeline("join", 1, { count: 0 })).some((e) => e.code === "config")).toBe(
      true
    );
    expect(() => parseFlow(" ".repeat(1048577))).toThrow("1 MiB");
  });
});
describe("bounded local FBP execution", () => {
  it("executes the shipped map/filter flow", async () => {
    expect(await output(exampleFlow())).toEqual([[6, 8]]);
  });
  it.each([
    ["map", [{ a: 1 }, { a: 2 }], { operation: "get", path: "a" }, [[1, 2]]],
    ["map", [1, 2], { operation: "add", value: 3 }, [[4, 5]]],
    ["filter", [1, 2, 3], { operator: "gte", value: 2 }, [[2, 3]]],
    ["filter", { tag: "abc" }, { path: "tag", operator: "contains", value: "b" }, [{ tag: "abc" }]],
    ["change", { before: true }, { field: "tag", value: "ok" }, [{ before: true, tag: "ok" }]],
    ["split", ["a", "b"], {}, ["a", "b"]],
    ["merge", { one: 1 }, {}, [{ one: 1 }]],
    ["json.parse", '{"a":1}', {}, [{ a: 1 }]],
    ["json.stringify", { a: 1 }, {}, ['{"a":1}']],
    ["delay", true, { milliseconds: 1 }, [true]]
  ] as [string, Json, Config, Json[]][])("executes %s", async (type, payload, config, expected) => {
    expect(await output(pipeline(type, payload, config))).toEqual(expected);
  });
  it("routes switch match and fallback ports", async () => {
    const flow = pipeline("switch", false, { operator: "eq", value: true });
    flow.edges[1] = edge("transform", "sink", "match");
    flow.nodes.push(node("fallback", "debug"));
    flow.edges.push(edge("transform", "fallback", "otherwise"));
    expect(await output(flow)).toEqual([false]);
  });
  it("joins split sequences and reports incomplete groups", async () => {
    const flow = pipeline("split", [1, 2, 3]);
    flow.nodes.splice(2, 0, node("join", "join", { count: 3 }));
    flow.edges = [edge("source", "transform"), edge("transform", "join"), edge("join", "sink")];
    expect(await output(flow)).toEqual([[1, 2, 3]]);
    flow.nodes[2].config.count = 4;
    expect((await runFlow(flow)).error).toContain("incomplete join");
  });
  it("pairs concat inputs FIFO, independent of arrival order", async () => {
    const flow: Flow = {
      version: 1,
      name: "concat",
      nodes: [
        node("a", "inject", { payload: [1] }),
        node("b", "inject", { payload: [2] }),
        node("c", "concat"),
        node("sink", "debug")
      ],
      edges: [edge("a", "c", "out", "right"), edge("b", "c", "out", "left"), edge("c", "sink")]
    };
    expect(await output(flow)).toEqual([[2, 1]]);
    flow.edges.shift();
    expect((await runFlow(flow)).error).toContain("incomplete join or concat");
  });
  it("deduplicates and takes with fresh state for each run", async () => {
    const flow = pipeline("split", [1, 1, 2, 3]);
    flow.nodes.push(node("dedup", "dedup"), node("take", "take", { count: 2 }));
    flow.edges = [
      edge("source", "transform"),
      edge("transform", "dedup"),
      edge("dedup", "take"),
      edge("take", "sink")
    ];
    expect(await output(flow)).toEqual([1, 2]);
    expect(await output(flow)).toEqual([1, 2]);
  });
  it("routes node errors explicitly and otherwise fails closed", async () => {
    const flow = pipeline("json.parse", "invalid");
    expect((await runFlow(flow)).status).toBe("failed");
    flow.edges = [edge("source", "transform"), edge("transform", "sink", "error")];
    const result = await runFlow(flow);
    expect(result.status).toBe("completed");
    expect(result.trace.find((e) => e.kind === "debug")?.payload).toMatchObject({
      nodeId: "transform"
    });
  });
  it("enforces fanout/message, step, byte and deadline budgets", async () => {
    expect(
      (await runFlow(pipeline("split", [1, 2, 3]), { limits: { messages: 2 } })).error
    ).toContain("Message budget");
    expect((await runFlow(exampleFlow(), { limits: { steps: 1 } })).error).toContain("Step budget");
    expect(
      (await runFlow(pipeline("merge", "long payload"), { limits: { payloadBytes: 3 } })).error
    ).toContain("byte budget");
    expect(
      (await runFlow(pipeline("delay", null, { milliseconds: 100 }), { limits: { timeoutMs: 2 } }))
        .error
    ).toContain("time budget");
  });
  it("supports cancellation before and during execution", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect((await runFlow(exampleFlow(), { signal: controller.signal })).status).toBe("cancelled");
    const running = new AbortController();
    const result = runFlow(pipeline("delay", 1, { milliseconds: 1000 }), {
      signal: running.signal
    });
    running.abort(new Error("stop"));
    expect((await result).status).toBe("cancelled");
  });
  it("isolates fork mutations and the authoring graph from trusted adapters", async () => {
    const flow = pipeline("code.lisp", { value: 1 });
    flow.nodes.push(node("other", "debug"));
    flow.edges.push(edge("source", "other"));
    const original = serializeFlow(flow);
    const adapter = vi.fn(async ({ payload, node }: { payload: Json; node: FlowNode }) => {
      (payload as Config).value = 99;
      node.label = "mutated";
      return payload;
    });
    const result = await runFlow(flow, {
      grants: ["code.lisp"],
      adapters: { "code.lisp": adapter }
    });
    expect(result.status).toBe("completed");
    expect(result.trace.filter((e) => e.kind === "debug").map((e) => e.payload)).toEqual([
      { value: 1 },
      { value: 99 }
    ]);
    expect(serializeFlow(flow)).toBe(original);
  });
});
describe("capability and canonical boundaries", () => {
  for (const def of CATALOG.filter((def) => def.adapter)) {
    it(`keeps ${def.type} disabled without both adapter and explicit grant`, async () => {
      const flow = pipeline(
        def.type,
        {},
        def.category === "Transport" ? { connectionRef: "fixture" } : {}
      );
      const adapter = vi.fn(async () => null);
      expect((await runFlow(flow, { adapters: { [def.adapter!]: adapter } })).error).toContain(
        "disabled"
      );
      expect((await runFlow(flow, { grants: [def.adapter!] })).error).toContain("disabled");
      expect(adapter).not.toHaveBeenCalled();
      expect(
        await output(flow, { grants: [def.adapter!], adapters: { [def.adapter!]: adapter } })
      ).toEqual([null]);
    });
  }
  it("times out an uncooperative adapter and never delivers its late result", async () => {
    let finish!: (value: Json) => void;
    const controller = new AbortController();
    const result = await runFlow(pipeline("code.prolog", true), {
      limits: { timeoutMs: 2 },
      adapters: {
        "code.prolog": async ({ signal }) => {
          signal.addEventListener("abort", () => controller.abort());
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
      },
      grants: ["code.prolog"]
    });
    expect(result.status).toBe("failed");
    expect(controller.signal.aborted).toBe(true);
    finish("late");
    await Promise.resolve();
    expect(result.trace.some((e) => e.nodeId === "sink")).toBe(false);
  });
  it("validates actual canonical payloads at document ports", async () => {
    const validateDocument = vi.fn((value: Json) => {
      if (!(value as Config)?.schema_version) throw new Error("invalid canonical");
    });
    expect(
      (await runFlow(pipeline("starintel.validate", {}), { validateDocument })).error
    ).toContain("invalid canonical");
    expect(
      await output(pipeline("starintel.validate", { schema_version: "0.10.1" }), {
        validateDocument
      })
    ).toEqual([{ schema_version: "0.10.1" }]);
    expect((await runFlow(pipeline("starintel.validate", {}))).error).toContain(
      "validator unavailable"
    );
  });
  it("rejects unsafe property traversal and inline transport credentials", async () => {
    expect(
      (await runFlow(pipeline("map", [{}], { operation: "get", path: "__proto__.secret" }))).error
    ).toContain("Unsafe property");
    expect(
      validateFlow(
        pipeline("transport.tcp", {}, { connectionRef: "fixture", password: "no" })
      ).some((e) => e.code === "config")
    ).toBe(true);
  });
});
