import { describe, expect, it } from "vitest";
import {
  actorTargetFromDocument,
  defaultConfigForManifest,
  editableConfigProperties,
  listProActorManifests,
  melissaTargetFromDocument,
  normalizeProActorManifest,
  targetOptionsForRun
} from "./pro-actors";

function manifest(actor = "melissa") {
  return {
    _id: `starintel:actor-manifest:${actor}`,
    dtype: "actor-manifest",
    data: {
      actor,
      target_options: [
        { key: "providers", type: "array" },
        { key: "fields", type: "object" },
        { key: "config", type: "object", default: {} }
      ]
    },
    extensions: {
      "starintel.actor_manifest.v1": {
        actor_id: actor,
        actor_type: "enricher",
        runtime: "python-pykka-actor-system",
        operations: ["query"],
        capabilities: ["target-driven-configuration"],
        implementation: { repository: "lost-rob0t/starintel-pro-actors", version: "0.3.0" },
        configuration_schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            workers: { type: "integer", minimum: 1, default: 3 },
            timeout: { type: "number", minimum: 1, default: 15 },
            license_key: { type: "string", writeOnly: true }
          }
        }
      }
    }
  };
}

describe("pro actor manifests", () => {
  it("discovers only canonical starintel-pro-actors manifests", () => {
    const good = manifest();
    const wrongRepo = structuredClone(good);
    wrongRepo._id = "foreign";
    wrongRepo.extensions["starintel.actor_manifest.v1"].implementation.repository = "someone/else";

    expect(listProActorManifests([wrongRepo, good]).map((item) => item.id)).toEqual(["melissa"]);
  });

  it("renders config defaults but never exposes write-only values", () => {
    const normalized = normalizeProActorManifest(manifest());
    expect(defaultConfigForManifest(normalized)).toEqual({ workers: 3, timeout: 15 });
    expect(editableConfigProperties(normalized).map((item) => item.name)).toEqual([
      "workers",
      "timeout"
    ]);
  });
});

describe("Melissa target derivation", () => {
  it("consumes person documents with useful identity fields", () => {
    const result = melissaTargetFromDocument({
      _id: "person:ada",
      dtype: "person",
      title: "Ada",
      data: {
        fname: "Ada",
        lname: "Lovelace",
        email: "ada@example.test",
        phone: "+1 614 555 0100",
        city: "Columbus",
        state: "OH"
      }
    });
    expect(result.targetType).toBe("person");
    expect(result.target).toBe("Ada Lovelace");
    expect(result.fields).toMatchObject({
      email: "ada@example.test",
      phone: "+1 614 555 0100",
      city: "Columbus",
      state: "OH"
    });
  });

  it("consumes org, phone, address, and geo documents", () => {
    expect(
      melissaTargetFromDocument({ _id: "o1", dtype: "org", data: { name: "Analytical Engines" } })
    ).toMatchObject({ targetType: "org", target: "Analytical Engines" });
    expect(
      melissaTargetFromDocument({ _id: "p1", dtype: "phone", data: { phone: "+16145550100" } })
    ).toMatchObject({ targetType: "phone", target: "+16145550100" });
    expect(
      melissaTargetFromDocument({
        _id: "a1",
        dtype: "address",
        data: { address: "1 Main St", city: "Columbus", state: "OH" }
      })
    ).toMatchObject({ targetType: "address", target: "1 Main St, Columbus, OH" });
    expect(
      melissaTargetFromDocument({
        _id: "g1",
        dtype: "location",
        data: { latitude: 39.9612, longitude: -82.9988 }
      })
    ).toEqual({ targetType: "geo", target: "39.9612,-82.9988", fields: {} });
  });

  it("is selected through the generic actor target resolver", () => {
    const normalized = normalizeProActorManifest(manifest());
    expect(
      actorTargetFromDocument(normalized, {
        _id: "ip:fixture",
        dtype: "ip",
        data: { ip: "203.0.113.7" }
      })
    ).toMatchObject({ targetType: "ip", target: "203.0.113.7" });
  });
});

describe("target option encoding", () => {
  it("keeps actor config and operation fields in canonical option entries", () => {
    expect(
      targetOptionsForRun(
        { workers: 5 },
        { providers: ["global-phone"], fields: { postal_code: "43215" } },
        { email: "ada@example.test" }
      )
    ).toEqual([
      { key: "config", value: { workers: 5 } },
      {
        key: "fields",
        value: { email: "ada@example.test", postal_code: "43215" }
      },
      { key: "providers", value: ["global-phone"] }
    ]);
  });
});
