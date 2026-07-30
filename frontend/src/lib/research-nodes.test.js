import { assertDocument } from "starintel_doc";
import { describe, expect, it } from "vitest";
import {
  createResearchNode,
  isResearchNode,
  researchNodeExecutionPlan,
  transitionResearchNode
} from "./research-nodes";

const stamp = "2026-07-26T21:00:00.000Z";

function node() {
  return createResearchNode({
    id: "starintel:research-node:columbus-flock",
    dataset: "columbus",
    title: "Columbus Flock research",
    objective: "Map the Flock deployment and responsible organizations.",
    instructions: "Prefer primary records and preserve provenance.",
    inputIds: ["starintel:target:columbus-flock"],
    targetIds: ["starintel:target:columbus-flock"],
    actorIds: ["quasar.actor.web-search", "quasar.actor.url-content"],
    createdAt: stamp
  });
}

describe("research nodes", () => {
  it("creates a valid canonical StarIntel research-node", () => {
    const document = node();
    expect(isResearchNode(document)).toBe(true);
    expect(document).toMatchObject({
      dtype: "research-node",
      status: "draft",
      data: {
        objective: "Map the Flock deployment and responsible organizations.",
        status: "draft"
      }
    });
    expect(() => assertDocument(document)).not.toThrow();
  });

  it("compiles an actor execution plan", () => {
    expect(researchNodeExecutionPlan(node())).toMatchObject({
      researchNodeId: "starintel:research-node:columbus-flock",
      inputIds: ["starintel:target:columbus-flock"],
      targetIds: ["starintel:target:columbus-flock"],
      actorIds: ["quasar.actor.web-search", "quasar.actor.url-content"],
      dependencyIds: []
    });
  });

  it("tracks validated state transitions and outputs", () => {
    const queued = transitionResearchNode(node(), "queued", {
      at: "2026-07-26T21:01:00.000Z",
      message: "Queued by operator"
    });
    const running = transitionResearchNode(queued, "running", {
      at: "2026-07-26T21:02:00.000Z",
      currentActorId: "quasar.actor.web-search",
      currentRunId: "run:research:001",
      counters: { actorRuns: 1 }
    });
    const completed = transitionResearchNode(running, "completed", {
      at: "2026-07-26T21:03:00.000Z",
      outputIds: ["starintel:org:example"],
      artifactIds: ["artifact:report"]
    });

    expect(completed.data).toMatchObject({
      status: "completed",
      output_ids: ["starintel:org:example"],
      artifact_ids: ["artifact:report"],
      run_ids: ["run:research:001"],
      completed_at: "2026-07-26T21:03:00.000Z"
    });
    expect(completed.data.history).toHaveLength(4);
    expect(completed.version).toBe(4);
    expect(() => assertDocument(completed)).not.toThrow();
  });

  it("rejects invalid state jumps", () => {
    expect(() => transitionResearchNode(node(), "completed")).toThrow("draft -> completed");
  });
});
