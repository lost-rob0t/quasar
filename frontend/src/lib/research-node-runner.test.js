import { describe, expect, it, vi } from "vitest";
import { createResearchNode } from "./research-nodes";
import { createResearchNodeRunner } from "./research-node-runner";

const stamp = "2026-07-28T06:00:00.000Z";
const input = {
  _id: "starintel:org:input",
  dataset: "test",
  dtype: "org",
  schema_version: "0.9.0",
  version: 1,
  date_added: stamp,
  date_updated: stamp,
  title: "Input",
  sources: [],
  evidence: [],
  data: { name: "Input" }
};

function researchNode(overrides = {}) {
  return createResearchNode({
    id: "starintel:research-node:test",
    dataset: "test",
    objective: "Build the graph",
    inputIds: [input._id],
    actorIds: ["actor:first", "actor:second"],
    createdAt: stamp,
    stop: {
      when_actor_queue_empty: true,
      when_no_new_documents: false,
      halt_on_actor_failure: true
    },
    ...overrides
  });
}

function output(id) {
  return { ...input, _id: id, title: id, data: { name: id } };
}

function harness({ node = researchNode(), runActor, actors, now } = {}) {
  const documents = new Map([
    [input._id, input],
    [node._id, node]
  ]);
  const actorList = actors || [
    { id: "actor:first", label: "First" },
    { id: "actor:second", label: "Second" }
  ];
  const saves = [];
  const runner = createResearchNodeRunner({
    resolveActor: (id) => actorList.find((actor) => actor.id === id),
    resolveDocument: (id) => documents.get(id),
    runActor:
      runActor ||
      vi.fn(async (actor) => {
        const document = output(`starintel:org:${actor.id.split(":").at(-1)}`);
        documents.set(document._id, document);
        return { documents: [document], newDocumentIds: [document._id], metrics: { requests: 1 } };
      }),
    saveNode: vi.fn(async (document) => {
      documents.set(document._id, document);
      saves.push(document);
    }),
    createRunId: (_node, actor) => `run:${actor.id}`,
    now: now || (() => Date.parse(stamp))
  });
  return { runner, documents, saves };
}

describe("research node runner", () => {
  it("runs the actor queue and persists bounded lifecycle state", async () => {
    const { runner, documents, saves } = harness();
    const completed = await runner.run(documents.get("starintel:research-node:test"));

    expect(completed.data.status).toBe("completed");
    expect(completed.data.output_ids).toEqual(["starintel:org:first", "starintel:org:second"]);
    expect(completed.data.run_ids).toEqual(["run:actor:first", "run:actor:second"]);
    expect(completed.data.counters).toMatchObject({ actor_runs: 2, requests: 2 });
    expect(saves.map((document) => document.data.status)).toContain("queued");
    expect(saves.at(-1).data.status).toBe("completed");
  });

  it("stops when an actor produces no new documents", async () => {
    const runActor = vi.fn(async () => ({ documents: [], newDocumentIds: [] }));
    const node = researchNode({
      stop: {
        when_actor_queue_empty: true,
        when_no_new_documents: true,
        halt_on_actor_failure: true
      }
    });
    const { runner } = harness({ node, runActor });
    const completed = await runner.run(node);

    expect(completed.data.status).toBe("completed");
    expect(completed.data.counters.actor_runs).toBe(1);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(completed.data.history.at(-1).message).toBe("No new documents were produced.");
  });

  it("blocks when an actor is unavailable or a hard limit is reached", async () => {
    const missing = researchNode({ actorIds: ["actor:missing"] });
    const missingRun = harness({ node: missing, actors: [] });
    const blockedMissing = await missingRun.runner.run(missing);
    expect(blockedMissing.data.status).toBe("blocked");
    expect(blockedMissing.data.last_error).toContain("Actor is unavailable");

    const limited = researchNode({ limits: { max_actor_runs: 1 } });
    const limitedRun = harness({ node: limited });
    const blockedLimit = await limitedRun.runner.run(limited);
    expect(blockedLimit.data.status).toBe("blocked");
    expect(blockedLimit.data.last_error).toBe("Actor run limit reached.");
  });

  it("aborts the active actor and records an operator pause", async () => {
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const runActor = vi.fn(
      (_actor, _selection, { signal }) =>
        new Promise((_resolve, reject) => {
          started();
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        })
    );
    const { runner, documents } = harness({ runActor });
    const running = runner.run(documents.get("starintel:research-node:test"));
    await ready;
    const paused = await runner.pause("starintel:research-node:test");

    expect(await running).toEqual(paused);
    expect(paused.data.status).toBe("paused");
    expect(paused.data.paused_reason).toBe("Paused by operator");
  });

  it("resets bounded counters for a fresh run of a terminal node", async () => {
    const completed = researchNode({
      status: "completed",
      actorIds: ["actor:first"],
      counters: {
        depth: 1,
        actor_runs: 64,
        requests: 100,
        repeated_state: 2,
        elapsed_ms: 10_000,
        cost: 4
      }
    });
    const { runner } = harness({ node: completed });
    const rerun = await runner.run(completed);

    expect(rerun.data.status).toBe("completed");
    expect(rerun.data.counters).toMatchObject({
      depth: 0,
      actor_runs: 1,
      requests: 1,
      repeated_state: 0,
      elapsed_ms: 0,
      cost: 0
    });
  });
});
