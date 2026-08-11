export const CACHE_NAME = "quasar-runtime-v4";
export const APP_SHELL = ["./", "./index.html", "./manifest.webmanifest"];

const IMMUTABLE_ASSET =
  /\/assets\/[^/]+-[a-zA-Z0-9_-]{6,}\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|avif|woff2?)$/;
const STATIC_DESTINATIONS = new Set(["script", "style", "image", "font"]);

export function isStaticAssetRequest(request) {
  const url = new URL(request.url);
  if (IMMUTABLE_ASSET.test(url.pathname)) return true;
  if (STATIC_DESTINATIONS.has(request.destination) && url.pathname.includes("/assets/"))
    return true;
  return /\/(?:manifest\.webmanifest|favicon\.(?:ico|svg)|apple-touch-icon\.png)$/.test(
    url.pathname
  );
}

export function mayStoreResponse(response) {
  if (!response?.ok || response.type === "opaque") return false;
  const cacheControl = response.headers.get("cache-control") || "";
  if (/\b(?:no-store|private)\b/i.test(cacheControl)) return false;
  if (response.headers.has("set-cookie")) return false;
  return true;
}

export async function networkFirstNavigation(
  request,
  { cacheStorage = caches, fetchRequest = fetch, fallback = "./index.html" } = {}
) {
  const cache = await cacheStorage.open(CACHE_NAME);
  try {
    const response = await fetchRequest(request);
    const contentType = response.headers.get("content-type") || "";
    if (mayStoreResponse(response) && /text\/html/i.test(contentType)) {
      await cache.put(fallback, response.clone());
    }
    if (response.ok) return response;
    return (await cache.match(fallback)) || response;
  } catch {
    return cache.match(fallback);
  }
}

export async function cacheFirstAsset(
  request,
  { cacheStorage = caches, fetchRequest = fetch } = {}
) {
  if (!isStaticAssetRequest(request)) return fetchRequest(request);

  const cached = await cacheStorage.match(request);
  if (cached) return cached;

  const response = await fetchRequest(request);
  if (mayStoreResponse(response)) {
    const cache = await cacheStorage.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}
