import { normalizeActorManifest } from "./actors-core";
import { browserActorManifestFromLegacy, createBrowserActorRuntime } from "./browser-actor-runtime";
import { createOpaqueOriginBrowserActorRuntime } from "./opaque-origin-actor-runtime";

const DEFAULT_ACTOR_TIMEOUT_MS = 30_000;
const MAX_ACTOR_TIMEOUT_MS = 120_000;
const MAX_ACTOR_DOCUMENTS = 1_024;
const ACTOR_RESPONSE_LIMIT = 1_048_576;
const FORBIDDEN_ACTOR_HEADER =
  /^(?:authorization|cookie|proxy-|sec-|host$|origin$|referer$|x-api-key$)/i;

function assertLiteralPublicHost(url) {
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
  ) {
    throw new Error("Actor network.fetch blocks private network URLs");
  }
}

async function readBoundedActorBody(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ACTOR_RESPONSE_LIMIT) {
      await reader.cancel("Actor response limit exceeded");
      throw new RangeError(`Actor response exceeds ${ACTOR_RESPONSE_LIMIT} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function networkFetchService(payload, { signal }) {
  const url = new URL(String(payload?.url || payload || ""));
  if (url.protocol !== "https:") throw new Error("Actor network.fetch requires HTTPS");
  assertLiteralPublicHost(url);
  const options = payload?.options && typeof payload.options === "object" ? payload.options : {};
  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(method)) throw new Error(`Actor network.fetch rejects ${method}`);
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).map(([name, value]) => {
      if (FORBIDDEN_ACTOR_HEADER.test(name)) {
        throw new Error(`Actor request header denied: ${name}`);
      }
      return [name, String(value)];
    })
  );
  const response = await fetch(url.href, {
    method,
    headers,
    credentials: "omit",
    redirect: "error",
    signal
  });
  const bytes = await readBoundedActorBody(response, signal);
  const raw = new TextDecoder().decode(bytes);
  const responseType = payload?.responseType === "json" ? "json" : "text";
  const body = responseType === "json" && raw ? JSON.parse(raw) : raw;
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: Object.fromEntries(response.headers.entries()),
    body
  };
}

function documentGetService(payload, { context }) {
  return (context.documents || []).find((document) => document._id === payload?.id) || null;
}

function documentQueryService(payload = {}, { context }) {
  const ids = new Set(Array.isArray(payload.ids) ? payload.ids : []);
  const limit = Math.max(1, Math.min(Number(payload.limit) || 100, 1_000));
  return (context.documents || [])
    .filter((document) => !ids.size || ids.has(document._id))
    .filter((document) => !payload.dataset || document.dataset === payload.dataset)
    .filter((document) => !payload.dtype || document.dtype === payload.dtype)
    .slice(0, limit);
}

function browserOpenService(payload) {
  const url = new URL(String(payload?.url || ""));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Actor browser.open rejects ${url.protocol || "unknown"} URLs`);
  }
  const opened = globalThis.open?.(url.href, "_blank", "noopener,noreferrer");
  return { opened: Boolean(opened), url: url.href };
}

function eventEmitService(payload) {
  const name = String(payload?.name || payload?.type || "").trim();
  if (!name) throw new Error("Actor event name is required");
  globalThis.dispatchEvent?.(new CustomEvent(`quasar:actor:${name}`, { detail: payload?.data }));
  return { emitted: true, name };
}

export async function runBrowserActor(
  manifest,
  context,
  { timeout = DEFAULT_ACTOR_TIMEOUT_MS, signal, onEvent, trusted = false } = {}
) {
  const actor = normalizeActorManifest(manifest);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_ACTOR_TIMEOUT_MS) {
    throw new TypeError(`Actor timeout must be an integer from 1 to ${MAX_ACTOR_TIMEOUT_MS}`);
  }

  const services = {
    "documents.get": documentGetService,
    "documents.query": documentQueryService,
    "network.fetch": networkFetchService,
    "browser.open": browserOpenService,
    "events.emit": eventEmitService
  };
  const runtime = trusted
    ? createBrowserActorRuntime({ services })
    : createOpaqueOriginBrowserActorRuntime({ services });

  let requests = 0;
  const result = await runtime.run(
    browserActorManifestFromLegacy({
      ...actor,
      timeoutMs: timeout,
      limits: {
        ...actor.limits,
        timeoutMs: timeout,
        maxDocuments: Math.min(
          actor.limits.maxDocuments || MAX_ACTOR_DOCUMENTS,
          MAX_ACTOR_DOCUMENTS
        )
      }
    }),
    context,
    {
      timeoutMs: timeout,
      signal,
      onEvent: (event) => {
        if (event.event === "capability-request") requests += 1;
        onEvent?.(event);
      }
    }
  );
  return {
    ...result,
    metrics: {
      ...result.metrics,
      requests: result.metrics.requests ?? requests
    }
  };
}
