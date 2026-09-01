import { assertDocument } from "starintel_doc";

const sessionTokens = new Map();

function serverUrl(configuration, path = "") {
  const base = String(configuration?.serverUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) throw new Error("StarIntel server URL is required");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function authorization(configuration, { allowBasic = false, token = null } = {}) {
  const bearer = String(token || configuration?.serverToken || "").trim();
  if (bearer) return `Bearer ${bearer}`;
  if (allowBasic && configuration?.serverUsername) {
    return `Basic ${btoa(`${configuration.serverUsername}:${configuration.serverPassword || ""}`)}`;
  }
  return null;
}

function networkFailure(configuration, path, error) {
  const origin = globalThis.location?.origin;
  const corsHint = origin ? ` Check STAR_AUTH_ALLOWED_ORIGINS includes ${origin}.` : "";
  const wrapped = new Error(
    `StarIntel server network/CORS failure for ${serverUrl(configuration, path)}.${corsHint}`,
    { cause: error }
  );
  wrapped.code = "network_or_cors";
  return wrapped;
}

async function request(configuration, path, options = {}) {
  const { allowBasic = false, token = null, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers || {});
  headers.set("Accept", "application/json");
  if (fetchOptions.body != null) headers.set("Content-Type", "application/json");
  const auth = authorization(configuration, { allowBasic, token });
  if (auth) headers.set("Authorization", auth);

  let response;
  try {
    response = await fetch(serverUrl(configuration, path), {
      ...fetchOptions,
      headers,
      signal: fetchOptions.signal || AbortSignal.timeout(10_000)
    });
  } catch (error) {
    throw networkFailure(configuration, path, error);
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = body?.message || body?.msg || `${response.status} ${response.statusText}`;
    const error = new Error(`StarIntel server: ${message}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function unwrapCapabilities(payload) {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload;
}

function capabilityEndpoint(capabilities, id, fallback) {
  const endpoint = capabilities?.endpoints?.find?.((candidate) => candidate?.id === id);
  return endpoint?.path || fallback;
}

function expandActorPath(template, actor) {
  const encoded = encodeURIComponent(actor);
  return String(template).replace(":actor", encoded).replace("{actor}", encoded);
}

async function discoverServer(configuration) {
  try {
    const payload = await request(configuration, "/api/v1/capabilities");
    return { mode: "v1", capabilities: unwrapCapabilities(payload) };
  } catch (error) {
    if (error.status !== 404) throw error;
    const legacy = await request(configuration, "/");
    return {
      mode: "legacy",
      capabilities: {
        schemaRevision: legacy?.doc_spec_version || "legacy",
        dataset: legacy?.["default-dataset"] || "default",
        endpoints: {
          submitTarget: "/new/target/:actor",
          submitDocument: "/new/document/:dtype",
          search: "/search"
        }
      },
      fallbackReason: error.message
    };
  }
}

function loginCacheKey(configuration) {
  return `${serverUrl(configuration)}\n${configuration?.serverUsername || ""}`;
}

function clearSessionToken(configuration = null) {
  if (!configuration) {
    sessionTokens.clear();
    return;
  }
  sessionTokens.delete(loginCacheKey(configuration));
}

async function login(configuration, { force = false } = {}) {
  const username = String(configuration?.serverUsername || "").trim();
  const password = String(configuration?.serverPassword || "");
  if (!username || !password) {
    throw new Error(
      "StarIntel API v1 requires an API key or a username/password login. Basic auth is not supported."
    );
  }

  const key = loginCacheKey(configuration);
  const cached = sessionTokens.get(key);
  if (!force && cached?.password === password && cached?.token) return cached.token;

  const response = await request(configuration, "/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  const token = response?.api_key || response?.data?.api_key;
  if (!token) throw new Error("StarIntel login succeeded without returning an API key");
  sessionTokens.set(key, { password, token });
  return token;
}

async function v1Token(configuration, { forceLogin = false } = {}) {
  const explicit = String(configuration?.serverToken || "").trim();
  if (explicit) return { token: explicit, source: "token" };
  return { token: await login(configuration, { force: forceLogin }), source: "login" };
}

async function authenticatedV1Request(configuration, path, options = {}) {
  let session = await v1Token(configuration);
  try {
    return await request(configuration, path, { ...options, token: session.token });
  } catch (error) {
    if (error.status !== 401 || session.source !== "login") throw error;
    clearSessionToken(configuration);
    session = await v1Token(configuration, { forceLogin: true });
    return request(configuration, path, { ...options, token: session.token });
  }
}

function requiresApiKey(capabilities) {
  const modes = capabilities?.authentication?.modes;
  return Array.isArray(modes) && modes.includes("api-key");
}

export async function probeStarIntelServer(configuration) {
  const discovered = await discoverServer(configuration);
  if (discovered.mode !== "v1") return discovered;
  if (!requiresApiKey(discovered.capabilities)) return discovered;

  const context = await authenticatedV1Request(configuration, "/auth/context");
  return { ...discovered, authenticated: true, context };
}

export async function submitTargetToServer(configuration, target) {
  const document = assertDocument(target);
  if (document.dtype !== "target")
    throw new Error("Only target documents can be submitted as targets");
  const actor = document.data?.actor;
  if (!actor) throw new Error("Target actor is required");

  const discovered = await discoverServer(configuration);
  if (discovered.mode === "v1") {
    const template = capabilityEndpoint(
      discovered.capabilities,
      "target_create",
      "/new/target/:actor"
    );
    return authenticatedV1Request(configuration, expandActorPath(template, actor), {
      method: "POST",
      body: JSON.stringify(document)
    });
  }

  return request(configuration, `/new/target/${encodeURIComponent(actor)}`, {
    method: "POST",
    allowBasic: true,
    body: JSON.stringify(document)
  });
}

export const starIntelServerInternals = Object.freeze({
  serverUrl,
  authorization,
  unwrapCapabilities,
  capabilityEndpoint,
  clearSessionToken
});
