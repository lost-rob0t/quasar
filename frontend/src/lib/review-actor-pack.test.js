import { assertDocument } from "starintel_doc";
import { describe, expect, it } from "vitest";
import {
  REVIEW_ACTOR,
  REVIEW_ACTOR_ID,
  markReviewedActor,
  mergeReviewActor
} from "./review-actor-pack";

const document = {
  _id: "starintel:person:test",
  dataset: "test",
  dtype: "person",
  schema_version: "0.9.0",
  version: 1,
  date_added: "2026-07-28T00:00:00.000Z",
  date_updated: "2026-07-28T00:00:00.000Z",
  title: "Test person",
  sources: [],
  evidence: [],
  data: { name: "Test person", full_name: "Test person" },
  verification: { verified: false, status: "unverified" }
};

describe("review actor", () => {
  it("marks selected documents reviewed without dropping fields", () => {
    const result = markReviewedActor({ selection: [document] });
    const updated = result.operations[0].document;

    expect(result.operations[0].op).toBe("update_document");
    expect(updated.verification).toMatchObject({
      verified: true,
      status: "reviewed"
    });
    expect(updated.data).toEqual(document.data);
    expect(updated.extensions["quasar.actor"]).toEqual({
      actor_id: REVIEW_ACTOR_ID,
      input_ids: [document._id]
    });
    expect(() => assertDocument(updated)).not.toThrow();
  });

  it("is a manual-only selected-document actor", () => {
    expect(REVIEW_ACTOR).toMatchObject({
      id: REVIEW_ACTOR_ID,
      minSelection: 1,
      maxSelection: 32,
      manualOnly: true
    });
    expect(Function(`"use strict"; return (${REVIEW_ACTOR.source});`)()).toBeTypeOf("function");
  });

  it("installs idempotently", () => {
    expect(
      mergeReviewActor([REVIEW_ACTOR, REVIEW_ACTOR]).filter((actor) => actor.id === REVIEW_ACTOR_ID)
    ).toHaveLength(1);
  });
});
