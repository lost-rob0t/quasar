import { describe, expect, it } from "vitest";
import {
  builtInCatalog,
  emptyWorkflow,
  operationsToNodes,
  workflowNodeFromDescriptor,
  validateWorkflow,
  workflowToLisp,
} from "./model";

describe("workflow model", () => {
  it("projects every StarIntel operation into one typed generic node", () => {
    const nodes = operationsToNodes([
      {
        operation_id: "targets.create",
        method: "post",
        path: "/api/v1/targets",
        summary: "Create target",
        tags: ["targets"],
        scopes: ["targets:dispatch"],
        request_schema: {
          type: "object",
          required: ["actor", "target"],
          properties: { actor: { type: "string" }, target: { type: "string" } },
        },
        responses: [{ status: 201, schema: { type: "object" } }],
      },
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("starintel.operation/targets.create");
    expect(nodes[0].inputs.map((port) => port.name)).toEqual(["request"]);
    expect(nodes[0].capabilities).toEqual(["targets:dispatch"]);
    expect(workflowNodeFromDescriptor(nodes[0], "target", 0, 0)).toMatchObject({
      type: "starintel/operation",
      config: { operation: "targets.create" },
    });
  });

  it("validates named ports and emits ordinary Lisp without reader evaluation", () => {
    const workflow = emptyWorkflow("hello");
    workflow.nodes = [
      { id: "copy", type: "core/identity", x: 0, y: 0, config: {} },
      { id: "split", type: "core/split", x: 220, y: 0, config: {} },
    ];
    workflow.iips = [{ id: "seed", value: ["a", "b"], to: "copy", in: "in" }];
    workflow.connections = [
      {
        id: "edge",
        from: "copy",
        out: "out",
        to: "split",
        in: "in",
        capacity: 4,
      },
    ];
    expect(validateWorkflow(workflow, builtInCatalog)).toEqual([]);
    const source = workflowToLisp(workflow);
    expect(source).toContain("(define-network hello");
    expect(source).toContain(":capacity 4");
    expect(source).not.toContain("#.");
  });

  it("rejects multiple producers and missing required inputs", () => {
    const workflow = emptyWorkflow("invalid");
    workflow.nodes = [
      { id: "copy", type: "core/identity", x: 0, y: 0, config: {} },
    ];
    expect(validateWorkflow(workflow, builtInCatalog)).toContain(
      "Required input copy.in is not connected",
    );
  });
});
