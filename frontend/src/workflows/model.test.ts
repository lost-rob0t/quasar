import { describe, expect, it } from "vitest";
import {
  builtInCatalog,
  connectWorkflowInput,
  emptyWorkflow,
  operationsToNodes,
  removeWorkflowNode,
  renameWorkflowNode,
  workflowNodeFromDescriptor,
  validateWorkflow,
  workflowToLisp
} from "./model";

describe("workflow model", () => {
  it("projects every StarIntel operation into one typed operation node", () => {
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
          properties: { actor: { type: "string" }, target: { type: "string" } }
        },
        responses: [{ status: 201, schema: { type: "object" } }]
      }
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("starintel.operation/targets.create");
    expect(nodes[0].inputs.map((port) => port.name)).toEqual(["actor", "target"]);
    expect(nodes[0].outputs.map((port) => port.name)).toEqual(["status-201"]);
    expect(nodes[0].capabilities).toEqual(["targets:dispatch"]);
    expect(workflowNodeFromDescriptor(nodes[0], "target", 0, 0)).toMatchObject({
      type: "starintel.operation/targets.create",
      config: {
        operation: "targets.create",
        credentialReference: "credential:starintel-api"
      }
    });
  });

  it("validates named ports and emits ordinary Lisp without reader evaluation", () => {
    const workflow = emptyWorkflow("hello");
    workflow.nodes = [
      { id: "copy", type: "core/identity", x: 0, y: 0, config: {} },
      { id: "split", type: "core/split", x: 220, y: 0, config: {} }
    ];
    workflow.iips = [{ id: "seed", value: ["a", "b"], to: "copy", in: "in" }];
    workflow.connections = [
      {
        id: "edge",
        from: "copy",
        out: "out",
        to: "split",
        in: "in",
        capacity: 4
      }
    ];
    expect(validateWorkflow(workflow, builtInCatalog)).toEqual([]);
    const source = workflowToLisp(workflow);
    expect(source).toContain("(define-network hello");
    expect(source).toContain(":capacity 4");
    expect(source).not.toContain("#.");
  });

  it("emits canonical kebab-case credential keys", () => {
    const workflow = emptyWorkflow("credential-key");
    workflow.nodes = [
      {
        id: "call",
        type: "starintel.operation/targets.create",
        x: 0,
        y: 0,
        config: {
          operation: "targets.create",
          credentialReference: "credential:starintel-api"
        }
      }
    ];
    workflow.iips = [{ id: "request", value: {}, to: "call", in: "request" }];
    expect(workflowToLisp(workflow)).toContain(':credential-reference "credential:starintel-api"');
  });

  it("rejects multiple producers and missing required inputs", () => {
    const workflow = emptyWorkflow("invalid");
    workflow.nodes = [{ id: "copy", type: "core/identity", x: 0, y: 0, config: {} }];
    expect(validateWorkflow(workflow, builtInCatalog)).toContain(
      "Required input copy.in is not connected"
    );
  });

  it("validates and cascades initial packets when nodes change", () => {
    const workflow = emptyWorkflow("integrity");
    workflow.nodes = [{ id: "copy", type: "core/identity", x: 0, y: 0, config: {} }];
    workflow.iips = [{ id: "copy:in:iip", value: 1, to: "copy", in: "in" }];
    renameWorkflowNode(workflow, "copy", "renamed");
    expect(workflow.iips[0]).toMatchObject({
      id: "renamed:in:iip",
      to: "renamed"
    });
    removeWorkflowNode(workflow, "renamed");
    expect(workflow.iips).toEqual([]);

    workflow.nodes = [{ id: "renamed", type: "core/identity", x: 0, y: 0, config: {} }];
    workflow.iips = [{ id: "orphan", value: 1, to: "missing", in: "in" }];
    expect(validateWorkflow(workflow, builtInCatalog)).toContain("Invalid initial packet orphan");
    expect(validateWorkflow(workflow, builtInCatalog)).toContain(
      "Required input renamed.in is not connected"
    );
  });

  it("replaces an initial packet when an input is connected", () => {
    const workflow = emptyWorkflow("connect");
    workflow.nodes = [
      { id: "from", type: "core/identity", x: 0, y: 0, config: {} },
      { id: "to", type: "core/identity", x: 0, y: 0, config: {} }
    ];
    workflow.iips = [
      { id: "from:in:iip", value: 1, to: "from", in: "in" },
      { id: "to:in:iip", value: 2, to: "to", in: "in" }
    ];
    connectWorkflowInput(workflow, "from", "out", "to", "in");
    expect(workflow.iips.map((iip) => iip.id)).toEqual(["from:in:iip"]);
    expect(validateWorkflow(workflow, builtInCatalog)).toEqual([]);
  });

  it("rejects duplicate initial packets", () => {
    const workflow = emptyWorkflow("duplicate-iip");
    workflow.nodes = [{ id: "copy", type: "core/identity", x: 0, y: 0, config: {} }];
    workflow.iips = [
      { id: "seed", value: 1, to: "copy", in: "in" },
      { id: "seed", value: 2, to: "copy", in: "in" }
    ];
    const errors = validateWorkflow(workflow, builtInCatalog);
    expect(errors).toContain("Duplicate initial packet seed");
    expect(errors).toContain("Input copy:in has multiple producers");
  });

  it("rejects literal initial packets for secret-annotated ports", () => {
    const workflow = emptyWorkflow("secret-input");
    const catalog = [
      ...builtInCatalog,
      {
        id: "test/secret",
        label: "Secret",
        category: "Test",
        inputs: [
          {
            name: "secret",
            required: true,
            schema: { type: "string", writeOnly: true }
          }
        ],
        outputs: []
      }
    ];
    workflow.nodes = [{ id: "secret", type: "test/secret", x: 0, y: 0, config: {} }];
    workflow.iips = [{ id: "literal", value: "password", to: "secret", in: "secret" }];
    expect(validateWorkflow(workflow, catalog)).toContain(
      "Initial packet literal must be a credential reference"
    );
  });
});
