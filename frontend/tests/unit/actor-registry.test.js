import { describe, expect, it } from "vitest";
import { normalizeRegistryActor, parseRegistryJsonl } from "../../src/lib/actor-registry";

const sample = JSON.stringify({
  actor_id: "fec",
  actor_type: "collector",
  capabilities: ["official-openfec-api", "streaming-bulk"],
  input_dtypes: ["target"],
  output_dtypes: ["entity", "relation"],
  authorization: { credentials: "FEC_API_KEY environment variable" },
  observedAt: "2026-11-19T00:00:00Z"
});

describe("forgejo actor registry", () => {
  it("normalizes a registry manifest into a display-only actor", () => {
    const actor = normalizeRegistryActor(JSON.parse(sample));
    expect(actor.id).toBe("pro-actor:fec");
    expect(actor.actorId).toBe("fec");
    expect(actor.serverManaged).toBe(true);
    expect(actor.readOnly).toBe(true);
    expect(actor.runtime).toBe("pro-actor-fleet");
    expect(actor.accepts).toEqual(["target"]);
    expect(actor.produces).toEqual(["entity", "relation"]);
    expect(actor.capabilities).toContain("official-openfec-api");
    expect(actor.description).toContain("FEC_API_KEY");
  });

  it("defaults accepts to wildcard when input dtypes are absent", () => {
    const actor = normalizeRegistryActor({ actor_id: "web" });
    expect(actor.accepts).toEqual(["*"]);
    expect(actor.capabilities).toEqual([]);
  });

  it("rejects entries without actor_id", () => {
    expect(() => normalizeRegistryActor({})).toThrow(/actor_id/);
    expect(() => normalizeRegistryActor(null)).toThrow();
  });

  it("parses multi-line JSONL and skips blank lines", () => {
    const actors = parseRegistryJsonl(`${sample}\n\n{"actor_id":"web"}\n`);
    expect(actors.map((actor) => actor.actorId)).toEqual(["fec", "web"]);
  });
});
