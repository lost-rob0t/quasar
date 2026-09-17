import { describe, expect, it } from "vitest";
import { workflowSaveOperations } from "./client";
import { emptyWorkflow } from "./model";

describe("workflow persistence operations", () => {
  it("creates, updates, and atomically renames only the selected workflow", () => {
    const workflow = emptyWorkflow("alpha");
    expect(workflowSaveOperations([], workflow, null)).toMatchObject([{ type: "document.create" }]);

    const alpha = {
      _id: "quasar:fbp:workflow:alpha",
      dtype: "quasar.fbp.workflow",
      body: workflow
    };
    expect(workflowSaveOperations([alpha], workflow, "alpha")).toMatchObject([
      { type: "document.update" }
    ]);

    workflow.id = "beta";
    expect(workflowSaveOperations([alpha], workflow, "alpha")).toMatchObject([
      { type: "document.delete", payload: { id: alpha._id } },
      { type: "document.create" }
    ]);
  });

  it("refuses to overwrite an existing workflow during rename", () => {
    const alpha = emptyWorkflow("alpha");
    const beta = emptyWorkflow("beta");
    const documents = [alpha, beta].map((body) => ({
      _id: `quasar:fbp:workflow:${body.id}`,
      dtype: "quasar.fbp.workflow",
      body
    }));
    expect(() => workflowSaveOperations(documents, beta, "alpha")).toThrow(
      "Workflow id already exists: beta"
    );
  });
});
