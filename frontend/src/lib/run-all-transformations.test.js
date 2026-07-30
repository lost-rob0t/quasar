import { describe, expect, it } from "vitest";
import {
  actorTouchedDocumentIds,
  linkedDocumentIds,
  mergeTransformationDocuments,
  recordTransformationRun,
  transformationBatches,
  transformationCandidates
} from "./run-all-transformations";

function actor(overrides = {}) {
  return {
    id: "actor.test",
    label: "Test actor",
    version: 1,
    accepts: ["entity"],
    minSelection: 1,
    maxSelection: 2,
    source: "() => ({ documents: [] })",
    ...overrides
  };
}

function entity(id, extension = null) {
  return {
    _id: id,
    dtype: "entity",
    version: 1,
    date_updated: "2026-01-01T00:00:00.000Z",
    extensions: extension ? { "quasar.actor": extension } : {}
  };
}

function relation(id, subject, object) {
  return {
    _id: id,
    dtype: "relation",
    data: { subject, object, predicate: "related-to" }
  };
}

describe("run-all transformation planning", () => {
  it("collects relation endpoints as linked documents", () => {
    expect(
      [
        ...linkedDocumentIds([
          relation("r1", "a", "b"),
          { _id: "r2", dtype: "relation", data: { source: "b", target: "c" } }
        ])
      ].sort()
    ).toEqual(["a", "b", "c"]);
  });

  it("treats actor outputs and their inputs as already touched", () => {
    const touched = actorTouchedDocumentIds(
      [
        entity("output", { actor_id: "actor.test", input_ids: ["input"] }),
        entity("other", { actor_id: "actor.other", input_ids: ["ignored"] })
      ],
      "actor.test"
    );

    expect([...touched].sort()).toEqual(["input", "output"]);
  });

  it("persists an actor-specific run ledger without deleting prior runs", () => {
    const first = recordTransformationRun(
      entity("input"),
      "actor.one",
      "run-1",
      "2026-07-28T12:00:00.000Z"
    );
    const second = recordTransformationRun(first, "actor.two", "run-2", "2026-07-28T12:01:00.000Z");

    expect(second.version).toBe(3);
    expect(second.extensions["quasar.transformations"].actors).toEqual({
      "actor.one": {
        run_id: "run-1",
        last_run_at: "2026-07-28T12:00:00.000Z"
      },
      "actor.two": {
        run_id: "run-2",
        last_run_at: "2026-07-28T12:01:00.000Z"
      }
    });
    expect([...actorTouchedDocumentIds([second], "actor.one")]).toEqual(["input"]);
  });

  it("runs inputs with no links or no prior actor run", () => {
    const linkedRan = recordTransformationRun(entity("linked-ran"), "actor.test", "run-1");
    const documents = [
      entity("unlinked-ran", {
        actor_id: "actor.test",
        input_ids: ["unlinked-ran"]
      }),
      entity("linked-new"),
      linkedRan,
      relation("r1", "linked-new", "anchor"),
      relation("r2", "linked-ran", "anchor")
    ];

    expect(
      transformationCandidates(actor(), documents, documents).map((document) => document._id)
    ).toEqual(["unlinked-ran", "linked-new"]);
  });

  it("rejects relation documents and unsupported dtypes", () => {
    const documents = [
      entity("accepted"),
      { _id: "person", dtype: "person" },
      relation("relation", "accepted", "person")
    ];

    expect(
      transformationCandidates(actor(), documents, documents).map((document) => document._id)
    ).toEqual(["accepted"]);
  });

  it("batches candidates by actor limits and drops an undersized tail", () => {
    const candidates = [entity("a"), entity("b"), entity("c"), entity("d"), entity("e")];
    const batches = transformationBatches(actor({ minSelection: 2, maxSelection: 2 }), candidates);

    expect(batches.map((batch) => batch.map((document) => document._id))).toEqual([
      ["a", "b"],
      ["c", "d"]
    ]);
  });

  it("supports zero-selection actors without looping", () => {
    expect(transformationBatches(actor({ minSelection: 0, maxSelection: 0 }), [])).toEqual([[]]);
  });

  it("merges actor outputs and removes deleted inputs for later transformations", () => {
    const merged = mergeTransformationDocuments(
      [entity("a"), entity("replace"), entity("removed")],
      [entity("b"), { ...entity("replace"), title: "updated" }],
      ["removed"]
    );

    expect(merged.map((document) => document._id).sort()).toEqual(["a", "b", "replace"]);
    expect(merged.find((document) => document._id === "replace")?.title).toBe("updated");
  });
});
