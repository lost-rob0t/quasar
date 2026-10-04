import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocument } from "starintel_doc/legacy";
import {
  listStarIntelActors,
  probeStarIntelServer,
  starIntelServerInternals,
  submitTargetToServer
} from "./starintel-server";

afterEach(() => vi.unstubAllGlobals());

describe("starintel-server client", () => {
  it("normalizes server URLs and auth headers", () => {
    expect(starIntelServerInternals.serverUrl({ serverUrl: "http://localhost:5000/" }, "/")).toBe(
      "http://localhost:5000/"
    );
    expect(starIntelServerInternals.authorization({ serverToken: "token" })).toBe("Bearer token");
  });

  it("falls back to the legacy capability seed", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            doc_spec_version: "0.7.3",
            "default-dataset": "starintel"
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      probeStarIntelServer({ serverUrl: "http://localhost:5000" })
    ).resolves.toMatchObject({
      mode: "legacy",
      capabilities: { schemaRevision: "0.7.3", dataset: "starintel" }
    });
  });

  it("discovers canonical registry entries with server-owned liveness", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          data: {
            schema: "starintel-actor-registry-v1",
            count: 2,
            actors: [
              {
                resourceUri: "star://local/actor/actor-event-receiver",
                resourceKind: "actor",
                semantic: {
                  name: "actor-event-receiver",
                  version: "1.0.0",
                  digest: "sha256:local"
                },
                accepts: { targets: ["event"], documents: [], messages: [] },
                produces: { targets: [], documents: ["event"], messages: [] },
                capabilities: ["receive"],
                operatorVisible: true,
                provenance: { sourcePackage: "starintel-gserver" },
                status: "online",
                ready: true,
                observedAt: "2026-10-03T12:00:00Z"
              },
              {
                resourceUri: "star://bbpd/actor/subfinder",
                resourceKind: "actor",
                semantic: {
                  name: "subfinder",
                  version: "2.1.0",
                  digest: "sha256:remote"
                },
                accepts: { targets: ["domain"], documents: [], messages: [] },
                produces: { targets: [], documents: ["domain"], messages: [] },
                capabilities: ["run"],
                operatorVisible: true,
                provenance: { sourcePackage: "star-bbpd" },
                status: "unavailable",
                ready: false
              }
            ]
          }
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetch);

    const actors = await listStarIntelActors({ serverUrl: "http://localhost:5000" });

    expect(fetch.mock.calls[0][0]).toBe("http://localhost:5000/v1/actors");
    expect(actors).toHaveLength(2);
    expect(actors[0]).toMatchObject({
      id: "star-runtime:star://local/actor/actor-event-receiver",
      actorId: "actor-event-receiver",
      serverManaged: true,
      resourceKind: "actor",
      sourcePackage: "starintel-gserver",
      status: "online",
      ready: true,
      alive: true
    });
    expect(actors[1]).toMatchObject({
      id: "star-runtime:star://bbpd/actor/subfinder",
      actorId: "subfinder",
      serverManaged: true,
      sourcePackage: "star-bbpd",
      status: "unavailable",
      ready: false,
      alive: false
    });
  });

  it("rejects unknown registry schemas and malformed liveness", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { schema: "future", actors: [] } }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              schema: "starintel-actor-registry-v1",
              count: 1,
              actors: [
                {
                  resourceUri: "star://local/actor/test",
                  resourceKind: "actor",
                  semantic: { name: "test", version: "1.0.0", digest: "sha256:test" },
                  accepts: { targets: [], documents: [], messages: [] },
                  produces: { targets: [], documents: [], messages: [] },
                  capabilities: [],
                  operatorVisible: true,
                  provenance: { sourcePackage: "test" },
                  status: "online",
                  ready: "yes"
                }
              ]
            }
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetch);

    await expect(listStarIntelActors({ serverUrl: "http://localhost:5000" })).rejects.toThrow(
      "unsupported actor registry schema"
    );
    await expect(listStarIntelActors({ serverUrl: "http://localhost:5000" })).rejects.toThrow(
      "ready must be a boolean"
    );
  });

  it("submits a v0.9 target through the v1 endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const target = createDocument("target", {
      dataset: "test",
      data: { actor: "actor-1", target: "starintel:person:one" }
    });

    await submitTargetToServer({ serverUrl: "http://localhost:5000" }, target);

    expect(fetch.mock.calls[0][0]).toBe("http://localhost:5000/api/v1/targets");
    expect(fetch.mock.calls[0][1].headers.get("Idempotency-Key")).toBe(target._id);
  });
});
