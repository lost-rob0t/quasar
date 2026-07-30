import { describe, expect, it, vi } from "vitest";
import {
  CACHE_NAME,
  cacheFirstAsset,
  isStaticAssetRequest,
  mayStoreResponse,
  networkFirstNavigation
} from "../../public/sw-runtime";

function fakeCacheStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  const key = (request) => (typeof request === "string" ? request : request.url);
  const cache = {
    put: vi.fn(async (request, response) => {
      entries.set(key(request), response);
    }),
    match: vi.fn(async (request) => entries.get(key(request)))
  };
  return {
    entries,
    open: vi.fn(async () => cache),
    match: vi.fn(async (request) => entries.get(key(request)))
  };
}

describe("service worker runtime cache", () => {
  it("uses the network for navigations even when an old page is cached", async () => {
    const request = new Request("https://example.test/quasar-ui/graph");
    const cacheStorage = fakeCacheStorage({
      [request.url]: new Response("stale validator bundle"),
      "./index.html": new Response("stale shell")
    });
    const fetchRequest = vi.fn().mockResolvedValue(
      new Response("fresh shell", {
        headers: { "content-type": "text/html" }
      })
    );

    const response = await networkFirstNavigation(request, { cacheStorage, fetchRequest });
    expect(await response.text()).toBe("fresh shell");
    expect(fetchRequest).toHaveBeenCalledWith(request);
    expect(cacheStorage.open).toHaveBeenCalledWith(CACHE_NAME);
    expect(await cacheStorage.entries.get("./index.html").text()).toBe("fresh shell");
    expect(cacheStorage.entries.get(request.url)).toBeDefined();
  });

  it("falls back to the cached shell when offline", async () => {
    const cached = new Response("offline shell");
    const cacheStorage = fakeCacheStorage({ "./index.html": cached });
    const response = await networkFirstNavigation(
      new Request("https://example.test/quasar-ui/graph"),
      { cacheStorage, fetchRequest: vi.fn().mockRejectedValue(new Error("offline")) }
    );

    expect(await response.text()).toBe("offline shell");
  });

  it("keeps content-hashed static assets cache-first", async () => {
    const request = new Request("https://example.test/quasar-ui/assets/index-abcdef.js");
    const cached = new Response("cached hashed asset");
    const cacheStorage = fakeCacheStorage({ [request.url]: cached });
    const fetchRequest = vi.fn();

    expect(isStaticAssetRequest(request)).toBe(true);
    const response = await cacheFirstAsset(request, { cacheStorage, fetchRequest });
    expect(await response.text()).toBe("cached hashed asset");
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it("does not cache dynamic same-origin API responses", async () => {
    const request = new Request("https://example.test/quasar-ui/api/v1/documents");
    const cacheStorage = fakeCacheStorage();
    const response = await cacheFirstAsset(request, {
      cacheStorage,
      fetchRequest: vi.fn().mockResolvedValue(new Response("private data"))
    });

    expect(isStaticAssetRequest(request)).toBe(false);
    expect(await response.text()).toBe("private data");
    expect(cacheStorage.open).not.toHaveBeenCalled();
  });

  it("rejects private and no-store responses from Cache Storage", () => {
    expect(mayStoreResponse(new Response("x", { headers: { "cache-control": "private" } }))).toBe(
      false
    );
    expect(mayStoreResponse(new Response("x", { headers: { "cache-control": "no-store" } }))).toBe(
      false
    );
    expect(mayStoreResponse(new Response("x"))).toBe(true);
  });
});
