import { afterEach, describe, expect, it, vi } from "vitest";
import { braveWebSearch, fetchUrlContent, scrapeWebsite } from "./agent-web";

const gatewayUrl = "https://gateway.example/api/v1/web/fetch";

afterEach(() => vi.restoreAllMocks());

describe("agent web tools", () => {
  it("normalizes Brave Search results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          web: {
            results: [{ title: "Example", url: "https://example.org/x", description: "Result" }]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const result = await braveWebSearch("test", { apiKey: "secret", count: 1 });
    expect(result.results).toEqual([
      expect.objectContaining({ title: "Example", url: "https://example.org/x" })
    ]);
    expect(fetch.mock.calls[0][1].headers["X-Subscription-Token"]).toBe("secret");
  });

  it("reads bounded content returned by the trusted gateway", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          finalUrl: "https://example.org/page",
          contentType: "text/html",
          bytes: 42,
          title: "Page",
          text: "Hello world",
          links: []
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await fetchUrlContent("https://example.org/page", { gatewayUrl });
    expect(result.title).toBe("Page");
    expect(result.text).toContain("Hello world");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      url: "https://example.org/page"
    });
  });

  it("blocks literal private-network URLs before contacting the gateway", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    await expect(fetchUrlContent("http://127.0.0.1/admin", { gatewayUrl })).rejects.toThrow(
      "Private network"
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("crawls bounded same-origin gateway results", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_gateway, options) => {
      const request = JSON.parse(options.body);
      if (request.url.endsWith("/start")) {
        return new Response(
          JSON.stringify({
            finalUrl: request.url,
            contentType: "text/html",
            bytes: 80,
            title: "Start",
            text: "Start",
            links: ["https://example.org/next", "https://elsewhere.test/nope"]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          finalUrl: request.url,
          contentType: "text/html",
          bytes: 20,
          title: "Next",
          text: "Done",
          links: []
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await scrapeWebsite("https://example.org/start", {
      maxPages: 5,
      maxDepth: 1,
      gatewayUrl
    });
    expect(result.pages.map((page) => page.title)).toEqual(["Start", "Next"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
