import { describe, expect, it } from "vitest";
import { createResearchNode } from "./research-nodes";
import {
  cloneResearchNode,
  researchNodeGraphData,
  researchNodeOutputIds,
  researchNodeScope
} from "./research-node-graph";

const at = "2026-07-28T04:00:00.000Z";

function fixture() {
  return createResearchNode({
    id: "starintel:research-node:source",
    dataset: "case-alpha",
    title: "Map the network",
    objective: "Map the network",
    inputIds: ["starintel:org:a"],
    targetIds: ["starintel:org:a", "starintel:person:b"],
    actorIds: ["actor:search"],
    dependencyIds: ["starintel:research-node:dependency"],
    createdAt: at
  });
}

describe("research node graph helpers", () => {
  it("projects state into a visible graph label", () => {
    expect(researchNodeGraphData(fixture(), "Map the network")).toEqual({
      researchStatus: "draft",
      researchLabel: "Map the network\n[draft]"
    });
    expect(researchNodeGraphData({ dtype: "org" }, "Org")).toBeNull();
  });

  it("deduplicates execution scope identifiers", () => {
    const document = fixture();
    document.data.output_ids = ["starintel:org:out", "starintel:org:out"];
    document.data.child_ids = ["starintel:research-node:child"];

    expect(researchNodeOutputIds(document)).toEqual(["starintel:org:out"]);
    expect(researchNodeScope(document)).toEqual({
      inputs: ["starintel:org:a", "starintel:person:b"],
      outputs: ["starintel:org:out"],
      dependencies: ["starintel:research-node:dependency"],
      children: ["starintel:research-node:child"],
      actors: ["actor:search"]
    });
  });

  it("clones a plan as a fresh draft without runtime results", () => {
    const document = fixture();
    document.data.status = "completed";
    document.status = "completed";
    document.data.output_ids = ["starintel:org:out"];

    const cloned = cloneResearchNode(document, {
      id: "starintel:research-node:copy",
      at: "2026-07-28T05:00:00.000Z"
    });

    expect(cloned).toMatchObject({
      _id: "starintel:research-node:copy",
      dataset: "case-alpha",
      title: "Map the network copy",
      status: "draft",
      data: {
        objective: "Map the network",
        status: "draft",
        input_ids: ["starintel:org:a"],
        target_ids: ["starintel:org:a", "starintel:person:b"],
        actor_ids: ["actor:search"],
        output_ids: []
      }
    });
  });
});
