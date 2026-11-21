import { describe, expect, it } from "vitest";
import { runFlow, validateCanonicalDocument, type Flow } from "./index";
describe("flow canonical schema boundary", () => {
  it("uses the actual locked canonical schema, preserving valid records and rejecting legacy shapes", async () => {
    const person = {
      id: "person:flow",
      dataset: "test",
      dtype: "person",
      schemaVersion: "0.10.1",
      fullName: "Flow Example"
    };
    expect(() => validateCanonicalDocument(person)).not.toThrow();
    expect(() =>
      validateCanonicalDocument({
        _id: "legacy",
        schema_version: "0.9.0",
        dtype: "person",
        data: {}
      })
    ).toThrow();
    const flow: Flow = {
      version: 1,
      name: "Canonical read",
      nodes: [
        { id: "a", label: "Input", type: "inject", config: { payload: person }, x: 0, y: 0 },
        { id: "b", label: "Validate", type: "starintel.validate", config: {}, x: 0, y: 0 },
        {
          id: "c",
          label: "Read name",
          type: "starintel.field",
          config: { path: "fullName" },
          x: 0,
          y: 0
        },
        { id: "d", label: "Debug", type: "debug", config: {}, x: 0, y: 0 }
      ],
      edges: [
        { id: "ab", from: { node: "a", port: "out" }, to: { node: "b", port: "in" } },
        { id: "bc", from: { node: "b", port: "out" }, to: { node: "c", port: "in" } },
        { id: "cd", from: { node: "c", port: "out" }, to: { node: "d", port: "in" } }
      ]
    };
    const result = await runFlow(flow, { validateDocument: validateCanonicalDocument });
    expect(result.status, result.error).toBe("completed");
    expect(result.trace.find((entry) => entry.kind === "debug")?.payload).toBe("Flow Example");
  });
});
