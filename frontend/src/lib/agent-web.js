const MAX_RESULTS = 20;
const MAX_CONTENT_BYTES = 1_000_000;
const MAX_TEXT_LENGTH = 100_000;
const MAX_SCRAPE_PAGES = 20;
const MAX_SCRAPE_DEPTH = 2;
const MAX_SCRAPE_BYTES = 3_000_000;

function publicHttpUrl(value) {
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol))
    throw new TypeError("URL must use HTTP or HTTPS");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
    throw new Error("Private network URLs are blocked");
  url.username = "";
  url.password = "";
  return url;
}

export async function braveWebSearch(
  query,
  { apiKey, count = 10, country = "us", freshness = "", signal } = {}
) {
  if (!apiKey) throw new Error("Brave Search key is missing");
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) throw new TypeError("Search query is required");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", cleanQuery);
  url.searchParams.set("count", String(Math.min(MAX_RESULTS, Math.max(1, Number(count) || 10))));
  if (country) url.searchParams.set("country", country);
  if (freshness) url.searchParams.set("freshness", freshness);
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey
    }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error("Brave Search rejected the key");
    if (response.status === 429) throw new Error("Brave Search rate limit reached");
    throw new Error(`Brave Search failed (${response.status})`);
  }
  const data = await response.json();
  return {
    query: cleanQuery,
    results: (data.web?.results || []).slice(0, MAX_RESULTS).map((result) => ({
      title: result.title || "",
      url: result.url || "",
      description: result.description || "",
      age: result.age || null,
      language: result.language || null,
      profile: result.profile
        ? {
            name: result.profile.long_name || result.profile.name || "",
            url: result.profile.url || ""
          }
        : null
    }))
  };
}

function htmlText(html, baseUrl) {
  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(html, "text/html");
    document
      .querySelectorAll("script,style,noscript,template,svg,canvas")
      .forEach((node) => node.remove());
    const title = document.querySelector("title")?.textContent?.trim() || "";
    const description =
      document.querySelector('meta[name="description"]')?.getAttribute("content") || "";
    const text = document.body?.textContent?.replace(/\s+/g, " ").trim() || "";
    const links = [...document.querySelectorAll("a[href]")]
      .map((node) => {
        try {
          const link = new URL(node.getAttribute("href"), baseUrl);
          link.hash = "";
          return ["http:", "https:"].includes(link.protocol) ? link.href : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { title, description, text, links: [...new Set(links)] };
  }
  const links = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => {
      try {
        const link = new URL(match[1], baseUrl);
        link.hash = "";
        return ["http:", "https:"].includes(link.protocol) ? link.href : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || "",
    description: "",
    text: html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    links: [...new Set(links)]
  };
}

function gatewayEndpoint(value) {
  if (!value) throw new Error("A trusted web fetch gateway must be configured");
  const url = new URL(String(value));
  const loopback =
    url.hostname === "localhost" || url.hostname === "::1" || /^127\./.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Web fetch gateway must use HTTPS unless it targets loopback");
  }
  url.username = "";
  url.password = "";
  return url;
}

export async function fetchUrlContent(
  value,
  { signal, maxBytes = MAX_CONTENT_BYTES, gatewayUrl, gatewayToken = "" } = {}
) {
  const requested = publicHttpUrl(value);
  const gateway = gatewayEndpoint(gatewayUrl);
  const response = await fetch(gateway, {
    method: "POST",
    credentials: "omit",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {})
    },
    body: JSON.stringify({ url: requested.href, maxBytes: Math.min(MAX_CONTENT_BYTES, maxBytes) })
  });
  if (!response.ok) throw new Error(`Web fetch gateway failed (${response.status})`);
  const payload = await response.json();
  const finalUrl = publicHttpUrl(payload.finalUrl || requested.href);
  const bytes = Number(payload.bytes || 0);
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > maxBytes) {
    throw new RangeError(`URL content exceeds ${maxBytes} bytes`);
  }
  return {
    requestedUrl: requested.href,
    finalUrl: finalUrl.href,
    contentType: String(payload.contentType || ""),
    bytes,
    title: String(payload.title || ""),
    description: String(payload.description || ""),
    text: String(payload.text || "").slice(0, MAX_TEXT_LENGTH),
    truncated: Boolean(payload.truncated) || String(payload.text || "").length > MAX_TEXT_LENGTH,
    links: (Array.isArray(payload.links) ? payload.links : [])
      .map((url) => publicHttpUrl(url).href)
      .slice(0, 500)
  };
}

export async function scrapeWebsite(
  value,
  {
    signal,
    maxPages = 10,
    maxDepth = 1,
    maxBytes = MAX_SCRAPE_BYTES,
    sameOrigin = true,
    gatewayUrl,
    gatewayToken = ""
  } = {}
) {
  const start = publicHttpUrl(value);
  const pageLimit = Math.min(MAX_SCRAPE_PAGES, Math.max(1, Number(maxPages) || 10));
  const depthLimit = Math.min(MAX_SCRAPE_DEPTH, Math.max(0, Number(maxDepth) || 0));
  const byteLimit = Math.min(MAX_SCRAPE_BYTES, Math.max(1, Number(maxBytes) || MAX_SCRAPE_BYTES));
  const queue = [{ url: start.href, depth: 0 }];
  const visited = new Set();
  const queued = new Set([start.href]);
  const pages = [];
  const errors = [];
  let totalBytes = 0;

  while (queue.length && pages.length < pageLimit && totalBytes < byteLimit) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    const next = queue.shift();
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    try {
      const page = await fetchUrlContent(next.url, {
        signal,
        maxBytes: Math.min(MAX_CONTENT_BYTES, byteLimit - totalBytes),
        gatewayUrl,
        gatewayToken
      });
      totalBytes += page.bytes;
      pages.push({ ...page, depth: next.depth });
      if (next.depth >= depthLimit) continue;
      for (const href of page.links) {
        if (queued.has(href)) continue;
        const link = publicHttpUrl(href);
        if (sameOrigin && link.origin !== start.origin) continue;
        queued.add(link.href);
        queue.push({ url: link.href, depth: next.depth + 1 });
        if (queued.size >= pageLimit * 50) break;
      }
    } catch (error) {
      errors.push({
        url: next.url,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    startUrl: start.href,
    pages,
    errors,
    pageCount: pages.length,
    totalBytes,
    truncated: queue.length > 0 || totalBytes >= byteLimit,
    limits: { maxPages: pageLimit, maxDepth: depthLimit, maxBytes: byteLimit, sameOrigin }
  };
}

export const WEB_LIMITS = Object.freeze({
  maxResults: MAX_RESULTS,
  maxContentBytes: MAX_CONTENT_BYTES,
  maxTextLength: MAX_TEXT_LENGTH,
  maxScrapePages: MAX_SCRAPE_PAGES,
  maxScrapeDepth: MAX_SCRAPE_DEPTH,
  maxScrapeBytes: MAX_SCRAPE_BYTES
});
