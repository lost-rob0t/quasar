import { describe, expect, it } from "vitest";
import { detectAgentLoop, fingerprint } from "./agent-loop-detector";

function call(name, args = {}, result = {}) {
  return { id: crypto.randomUUID(), kind: "tool", name, arguments: args, resultSummary: result };
}

describe("agent loop detection", () => {
  it("detects identical calls", () => {
    const history = [
      call("query_database", { text: "x" }),
      call("query_database", { text: "x" }),
      call("query_database", { text: "x" })
    ];
    expect(detectAgentLoop(history)?.pattern).toBe("identical-tool-call");
  });

  it("detects equivalent calls with reordered arguments", () => {
    const history = [
      call("query_graph", { dataset: "a", depth: 1 }),
      call("query_graph", { depth: 1, dataset: "a" }),
      call("query_graph", { dataset: "a", depth: 1 })
    ];
    expect(detectAgentLoop(history)?.pattern).toBe("identical-tool-call");
  });

  it("detects alternating action cycles", () => {
    const history = [
      call("create", { id: "x" }),
      call("delete", { id: "x" }),
      call("create", { id: "x" }),
      call("delete", { id: "x" }),
      call("create", { id: "x" }),
      call("delete", { id: "x" })
    ];
    expect(detectAgentLoop(history)?.pattern).toBe("alternating-actions");
  });

  it("detects no progress", () => {
    const state = fingerprint({ documents: ["same"] });
    const history = [0, 1, 2].map((index) => ({
      id: String(index),
      kind: "model",
      text: String(index),
      stateFingerprint: state
    }));
    expect(detectAgentLoop(history)?.pattern).toBe("no-progress");
  });
});
