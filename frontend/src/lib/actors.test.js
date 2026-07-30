import { assertDocument } from "starintel_doc";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_ACTORS,
  actorApplicability,
  actorsForTarget,
  generateUsernameCandidatesActor,
  isBuiltinActor,
  markUnverifiedActor,
  normalizeActorManifest,
  resolveLegistarClient,
  normalizeNamesActor,
  prepareWhatsMyNameSearchesActor,
  relationsFromRelatedIdsActor,
  targetInputExpansionActor
} from "./actors";

const stamp = "2026-07-26T00:00:00.000Z";
const person = {
  _id: "starintel:person:jane-q-doe",
  dataset: "test",
  dtype: "person",
  schema_version: "0.9.0",
  version: 1,
  date_added: stamp,
  date_updated: stamp,
  title: "Jane Q. Doe",
  sources: [],
  evidence: [],
  data: {
    fname: "Jane",
    mname: "Q",
    lname: "Doe",
    external_ids: [{ scheme: "username", value: "@jqdoe" }]
  }
};

describe("actor manifests", () => {
  it("requires an ID and bounded selection contract", () => {
    expect(() =>
      normalizeActorManifest({ label: "Missing", source: "() => ({ documents: [] })" })
    ).toThrow("Actor id is required");
    expect(() =>
      normalizeActorManifest({
        id: "test.actor",
        source: "() => ({ documents: [] })",
        minSelection: 4,
        maxSelection: 2
      })
    ).toThrow("Actor maxSelection");
  });

  it("explains selection and dtype applicability", () => {
    const actor = {
      id: "test.actor",
      label: "Test",
      version: 1,
      accepts: ["person"],
      minSelection: 1,
      maxSelection: 1,
      source: "() => ({ documents: [] })"
    };

    expect(actorApplicability(actor, [])).toEqual({
      applicable: false,
      reason: "Select a graph document."
    });
    expect(actorApplicability(actor, [{ ...person, dtype: "org" }])).toEqual({
      applicable: false,
      reason: "Does not accept org documents."
    });
    expect(actorApplicability(actor, [person])).toEqual({ applicable: true, reason: "" });
  });

  it("recognizes bundled actors by both identity and source", () => {
    expect(BUILTIN_ACTORS.every(isBuiltinActor)).toBe(true);
    expect(isBuiltinActor({ ...BUILTIN_ACTORS[0], source: "() => ({ documents: [] })" })).toBe(
      false
    );
  });

  it("preserves declared runtime capabilities for the host actor boundary", () => {
    const actor = normalizeActorManifest({
      id: "test.network",
      source: "() => ({ documents: [] })",
      capabilities: ["network.fetch", "network.fetch"]
    });
    expect(actor.runtime).toBe("quasar.browser-js.v1");
    expect(actor.capabilities).toEqual(["network.fetch"]);
    expect(
      BUILTIN_ACTORS.find((item) => item.id === "quasar.actor.city-legistar-calendar")?.capabilities
    ).toEqual(["network.fetch"]);
  });

  it("ships executable worker function sources", () => {
    for (const actor of BUILTIN_ACTORS) {
      const implementation = Function(`"use strict"; return (${actor.source});`)();
      expect(implementation).toBeTypeOf("function");
    }
  });
});

describe("username actors", () => {
  it("generates canonical username candidates and relations from a person name", () => {
    const result = generateUsernameCandidatesActor({ selection: [person] });
    const candidates = result.documents.filter((document) => document.dtype === "entity");

    expect(candidates.map((document) => document.data.name)).toEqual(
      expect.arrayContaining(["jqdoe", "janedoe", "jane.doe", "jdoe"])
    );
    expect(result.documents).toHaveLength(candidates.length * 2);
    result.documents.forEach((document) => expect(() => assertDocument(document)).not.toThrow());
  });

  it("prepares bounded WhatsMyName enumeration links from names and identifiers", () => {
    const result = prepareWhatsMyNameSearchesActor({ selection: [person] });
    const searches = result.documents.filter((document) => document.dtype === "entity");
    const jqdoe = searches.find((document) => document.data.external_ids[0].value === "jqdoe");

    expect(jqdoe.data.website).toBe("https://whatsmyname.app/?q=jqdoe");
    expect(searches).toHaveLength(11);
    expect(result.documents).toHaveLength(22);
    result.documents.forEach((document) => expect(() => assertDocument(document)).not.toThrow());
  });

  it("caps work for oversized selections", () => {
    const selection = Array.from({ length: 40 }, (_, index) => ({
      ...person,
      _id: `${person._id}:${index}`
    }));
    const candidates = generateUsernameCandidatesActor({ selection });
    const searches = prepareWhatsMyNameSearchesActor({ selection });

    expect(candidates.documents.length).toBeLessThanOrEqual(8 * 16 * 2);
    expect(searches.documents.length).toBeLessThanOrEqual(16 * 16 * 2);
    expect(candidates.message).toContain("first 8 selected documents");
    expect(searches.message).toContain("first 16 selected documents");
  });
});

describe("operator actors", () => {
  it("normalizes names as an update transform", () => {
    const result = normalizeNamesActor({ selection: [{ ...person, title: "  Jane   Q. Doe " }] });
    expect(result.operations[0].op).toBe("update_document");
    expect(result.operations[0].document.title).toBe("Jane Q. Doe");
  });

  it("builds valid explicit relations from related IDs", () => {
    const result = relationsFromRelatedIdsActor({
      selection: [{ ...person, related_ids: ["starintel:org:example"] }],
      documents: [person]
    });
    expect(result.operations).toHaveLength(1);
    expect(() => assertDocument(result.operations[0].document)).not.toThrow();
  });

  it("marks documents unverified without dropping fields", () => {
    const result = markUnverifiedActor({ selection: [person] });
    expect(result.operations[0].document.verification).toMatchObject({
      verified: false,
      status: "unverified"
    });
    expect(result.operations[0].document.data).toEqual(person.data);
  });
  it("normalizes target-create triggers", () => {
    const actor = normalizeActorManifest({
      id: "test.triggered",
      source: "() => ({ documents: [] })",
      triggers: ["target:create", "target:create", ""]
    });
    expect(actor.triggers).toEqual(["target:create"]);
  });

  it("selects trigger actors and explicitly requested target actors", () => {
    const target = {
      ...person,
      _id: "starintel:target:test",
      dtype: "target",
      data: { target: "Columbus", actor: "quasar.actor.city-legistar-calendar" }
    };
    const selected = actorsForTarget(BUILTIN_ACTORS, target);
    expect(selected.map((actor) => actor.id)).toEqual(
      expect.arrayContaining([
        "quasar.actor.target-input-expansion",
        "quasar.actor.city-legistar-calendar"
      ])
    );
  });

  it("expands URL target inputs into canonical entities and relations", () => {
    const target = {
      ...person,
      _id: "starintel:target:url",
      dtype: "target",
      data: { target: "https://example.com/path" }
    };
    const result = targetInputExpansionActor({ selection: [target], documents: [target] });
    const entity = result.documents.find((document) => document.dtype === "entity");
    const relation = result.documents.find((document) => document.dtype === "relation");
    expect(entity.data).toMatchObject({ etype: "url", website: "https://example.com/path" });
    expect(relation.data).toMatchObject({
      subject: target._id,
      object: entity._id,
      predicate: "targets"
    });
    result.documents.forEach((document) => expect(() => assertDocument(document)).not.toThrow());
  });

  it("links target document references without duplicating the referenced document", () => {
    const target = {
      ...person,
      _id: "starintel:target:reference",
      dtype: "target",
      data: { target: person._id }
    };
    const result = targetInputExpansionActor({ selection: [target], documents: [target, person] });
    expect(result.documents.filter((document) => document.dtype !== "relation")).toHaveLength(0);
    expect(result.documents[0].data.object).toBe(person._id);
  });

  it("resolves generic city and Legistar URL inputs", () => {
    expect(resolveLegistarClient({ data: { target: "Columbus, Ohio" } })).toBe("columbus");
    expect(
      resolveLegistarClient({ data: { target: "https://webapi.legistar.com/v1/newyork/events" } })
    ).toBe("newyork");
    expect(
      resolveLegistarClient({ data: { target: "https://chicago.legistar.com/Calendar.aspx" } })
    ).toBe("chicago");
  });
});
