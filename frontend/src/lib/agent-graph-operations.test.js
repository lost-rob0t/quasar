import { describe, expect, it, vi } from "vitest";

vi.mock("./operations", () => ({
  operation: {
    save: (document) => ({ type: "save-document", document }),
    remove: (id) => ({ type: "remove-document", id }),
    batch: (operations, label) => ({ type: "batch", operations, label })
  }
}));
import { applyAgentGraphPlan, previewAgentGraphOperations } from "./agent-graph-operations";

const stamp = "2026-07-26T00:00:00.000Z";
const person = {
  _id: "person:1",
  dataset: "alpha",
  dtype: "person",
  schema_version: "0.9.0",
  version: 1,
  date_added: stamp,
  date_updated: stamp,
  title: "Alice",
  sources: [],
  evidence: [],
  data: { name: "Alice" }
};

describe("agent graph operations", () => {
  it("previews exact validated changes with provenance", () => {
    const next = { ...person, title: "Alice Updated", version: 2 };
    const plan = previewAgentGraphOperations([person], [{ op: "update_node", document: next }], {
      agentId: "operator",
      runId: "run:1"
    });
    expect(plan.changes[0].document.extensions["quasar.agent"].run_id).toBe("run:1");
    expect(plan.requiresApproval).toBe(false);
  });

  it("blocks destructive plans without approval", async () => {
    const plan = previewAgentGraphOperations([person], [{ op: "delete_node", id: person._id }], {
      agentId: "operator",
      runId: "run:1"
    });
    await expect(
      applyAgentGraphPlan(plan, {
        execute: vi.fn(),
        applyWorkspaceOperation: vi.fn()
      })
    ).rejects.toMatchObject({ code: "approval_required" });
  });

  it("routes an approved plan through the undoable operation path", async () => {
    const execute = vi.fn(async () => {});
    const plan = previewAgentGraphOperations([person], [{ op: "delete_node", id: person._id }], {
      agentId: "operator",
      runId: "run:1"
    });
    await applyAgentGraphPlan(
      plan,
      { execute, applyWorkspaceOperation: vi.fn() },
      { approved: true }
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].type).toBe("batch");
  });
});
