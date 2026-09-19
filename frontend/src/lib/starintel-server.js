import { assertDocument } from "starintel_doc";

function serverUrl(configuration, path = "") {
  const base = String(configuration?.serverUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) throw new Error("StarIntel server URL is required");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function authorization(configuration) {
  if (configuration?.serverToken) return `Bearer ${configuration.serverToken}`;
  if (configuration?.serverUsername) {
    return `Basic ${btoa(`${configuration.serverUsername}:${configuration.serverPassword || ""}`)}`;
  }
  return null;
}

async function request(configuration, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.body != null) headers.set("Content-Type", "application/json");
  const auth = authorization(configuration);
  if (auth) headers.set("Authorization", auth);
  const response = await fetch(serverUrl(configuration, path), {
    ...options,
    headers,
    signal: options.signal || AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = body?.message || body?.msg || `${response.status} ${response.statusText}`;
    throw new Error(`StarIntel server: ${message}`);
  }
  return body;
}

export async function probeStarIntelServer(configuration) {
  try {
    const capabilities = await request(configuration, "/api/v1/capabilities");
    return { mode: "v1", capabilities };
  } catch (error) {
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

export async function submitTargetToServer(configuration, target) {
  const document = assertDocument(target);
  if (document.dtype !== "target")
    throw new Error("Only target documents can be submitted as targets");
  const actor = document.data?.actor;
  if (!actor) throw new Error("Target actor is required");
  try {
    return await request(configuration, "/api/v1/targets", {
      method: "POST",
      headers: { "Idempotency-Key": document._id },
      body: JSON.stringify(document)
    });
  } catch (error) {
    if (!/404|not found/i.test(error.message)) throw error;
    return request(configuration, `/new/target/${encodeURIComponent(actor)}`, {
      method: "POST",
      body: JSON.stringify(document)
    });
  }
}

export const starIntelServerInternals = Object.freeze({ serverUrl, authorization });
