import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocument } from "starintel_doc";
import {
  probeStarIntelServer,
  starIntelServerInternals,
  submitTargetToServer
} from "./starintel-server";

afterEach(() => {
  starIntelServerInternals.clearSessionToken();
  vi.unstubAllGlobals();
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function v1Capabilities(overrides = {}) {
  return {
    status: "ok",
    data: {
      authentication: { modes: ["api-key"] },
      endpoints: [{ id: "target_create", path: "/new/target/:actor" }],
      ...overrides
    }
  };
}

describe("starintel-server client", () => {
  it("normalizes URLs and keeps Basic auth legacy-only", () => {
    expect(starIntelServerInternals.serverUrl({ serverUrl: "http://localhost:5000/" }, "/")).toBe(
      "http://localhost:5000/"
    );
    expect(starIntelServerInternals.authorization({ serverToken: "token" })).toBe("Bearer token");
    expect(
      starIntelServerInternals.authorization(
        { serverUsername: "star", serverPassword: "intel" },
        { allowBasic: false }
      )
    ).toBeNull();
    expect(
      starIntelServerInternals.authorization(
        { serverUsername: "star", serverPassword: "intel" },
        { allowBasic: true }
      )
    ).toBe(`Basic ${btoa("star:intel")}`);
  });

  it("discovers v1 without credentials, logs in, then validates the bearer context", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(v1Capabilities()))
      .mockResolvedValueOnce(jsonResponse({ api_key: "star_sk_v1_session" }, 201))
      .mockResolvedValueOnce(jsonResponse({ principal_id: "user:quasar-ci" }));
    vi.stubGlobal("fetch", fetch);

    const result = await probeStarIntelServer({
      serverUrl: "http://localhost:5000",
      serverUsername: "quasar-ci",
      serverPassword: "known-password"
    });

    expect(result).toMatchObject({
      mode: "v1",
      authenticated: true,
      capabilities: { authentication: { modes: ["api-key"] } }
    });
    expect(fetch.mock.calls[0][0]).toBe("http://localhost:5000/api/v1/capabilities");
    expect(fetch.mock.calls[0][1].headers.has("Authorization")).toBe(false);
    expect(fetch.mock.calls[1][0]).toBe("http://localhost:5000/auth/login");
    expect(fetch.mock.calls[1][1].headers.has("Authorization")).toBe(false);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      username: "quasar-ci",
      password: "known-password"
    });
    expect(fetch.mock.calls[2][0]).toBe("http://localhost:5000/auth/context");
    expect(fetch.mock.calls[2][1].headers.get("Authorization")).toBe(
      "Bearer star_sk_v1_session"
    );
  });

  it("uses an explicit API key without calling the login route", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(v1Capabilities()))
      .mockResolvedValueOnce(jsonResponse({ principal_id: "service:quasar" }));
    vi.stubGlobal("fetch", fetch);

    await probeStarIntelServer({
      serverUrl: "http://localhost:5000",
      serverToken: "star_sk_v1_explicit"
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe("http://localhost:5000/auth/context");
    expect(fetch.mock.calls[1][1].headers.get("Authorization")).toBe(
      "Bearer star_sk_v1_explicit"
    );
  });

  it("reports missing v1 credentials instead of silently attempting Basic auth", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(v1Capabilities()));
    vi.stubGlobal("fetch", fetch);

    await expect(
      probeStarIntelServer({ serverUrl: "http://localhost:5000", serverUsername: "quasar-ci" })
    ).rejects.toThrow(/API key or a username\/password login/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the legacy capability seed only when v1 discovery is missing", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          doc_spec_version: "0.7.3",
          "default-dataset": "starintel"
        })
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      probeStarIntelServer({ serverUrl: "http://localhost:5000" })
    ).resolves.toMatchObject({
      mode: "legacy",
      capabilities: { schemaRevision: "0.7.3", dataset: "starintel" }
    });
  });

  it("does not hide v1 server errors behind a legacy fallback", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ msg: "boom" }, 500));
    vi.stubGlobal("fetch", fetch);

    await expect(
      probeStarIntelServer({ serverUrl: "http://localhost:5000" })
    ).rejects.toThrow("StarIntel server: boom");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the advertised current target route with bearer auth", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(v1Capabilities()))
      .mockResolvedValueOnce(jsonResponse({ status: "accepted" }, 202));
    vi.stubGlobal("fetch", fetch);
    const target = createDocument("target", {
      dataset: "test",
      data: { actor: "actor one", target: "starintel:person:one" }
    });

    await submitTargetToServer(
      { serverUrl: "http://localhost:5000", serverToken: "star_sk_v1_target" },
      target
    );

    expect(fetch.mock.calls[1][0]).toBe("http://localhost:5000/new/target/actor%20one");
    expect(fetch.mock.calls[1][1].headers.get("Authorization")).toBe("Bearer star_sk_v1_target");
    expect(fetch.mock.calls[1][1].headers.has("Idempotency-Key")).toBe(false);
  });

  it("retains Basic auth only for legacy target submission", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ doc_spec_version: "0.7.3" }))
      .mockResolvedValueOnce(jsonResponse({ status: "accepted" }, 202));
    vi.stubGlobal("fetch", fetch);
    const target = createDocument("target", {
      dataset: "test",
      data: { actor: "legacy", target: "starintel:person:one" }
    });

    await submitTargetToServer(
      {
        serverUrl: "http://localhost:5000",
        serverUsername: "legacy-user",
        serverPassword: "legacy-pass"
      },
      target
    );

    expect(fetch.mock.calls[2][0]).toBe("http://localhost:5000/new/target/legacy");
    expect(fetch.mock.calls[2][1].headers.get("Authorization")).toBe(
      `Basic ${btoa("legacy-user:legacy-pass")}`
    );
  });

  it("reuses a password-login session token within the browser session", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(v1Capabilities()))
      .mockResolvedValueOnce(jsonResponse({ api_key: "star_sk_v1_cached" }, 201))
      .mockResolvedValueOnce(jsonResponse({ principal_id: "user:quasar-ci" }))
      .mockResolvedValueOnce(jsonResponse(v1Capabilities()))
      .mockResolvedValueOnce(jsonResponse({ principal_id: "user:quasar-ci" }));
    vi.stubGlobal("fetch", fetch);
    const configuration = {
      serverUrl: "http://localhost:5000",
      serverUsername: "quasar-ci",
      serverPassword: "known-password"
    };

    await probeStarIntelServer(configuration);
    await probeStarIntelServer(configuration);

    const loginCalls = fetch.mock.calls.filter(([url]) => url.endsWith("/auth/login"));
    expect(loginCalls).toHaveLength(1);
  });
});
