import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocument } from "starintel_doc";
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

  it("discovers local Lisp and remote BBPD actor deployments", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          data: {
            actors: [
              {
                id: "actor-event-receiver",
                label: "actor-event-receiver",
                description: "Local Common Lisp StarIntel actor.",
                service: {
                  id: "starintel-gserver",
                  kind: "starintel-server",
                  language: "common-lisp"
                },
                runtime: { location: "local", transport: "sento" },
                dispatch: { dtype: "target", actor: "actor-event-receiver" }
              },
              {
                id: "subfinder",
                label: "Subfinder",
                description: "Discover subdomains.",
                service: { id: "bbp-actors", kind: "star-bbpd", language: "python" },
                runtime: {
                  location: "remote",
                  transport: "rabbitmq",
                  routing_key: "actors.subfinder.new.target"
                },
                dispatch: { dtype: "target", actor: "subfinder" }
              }
            ]
          }
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetch);

    const actors = await listStarIntelActors({ serverUrl: "http://localhost:5000" });

    expect(fetch.mock.calls[0][0]).toBe("http://localhost:5000/api/v1/actors");
    expect(actors).toHaveLength(2);
    expect(actors[0]).toMatchObject({
      id: "star-runtime:actor-event-receiver",
      actorId: "actor-event-receiver",
      serverManaged: true,
      origin: "local",
      language: "common-lisp",
      serviceId: "starintel-gserver"
    });
    expect(actors[1]).toMatchObject({
      id: "star-runtime:subfinder",
      actorId: "subfinder",
      serverManaged: true,
      origin: "remote",
      language: "python",
      serviceId: "bbp-actors"
    });
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
