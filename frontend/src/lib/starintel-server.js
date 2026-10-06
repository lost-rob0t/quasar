import { toCanonicalDocument } from "./canonical-document";

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

const ACTOR_REGISTRY_SCHEMA = "starintel-actor-registry-v1";
const ACTOR_RUNTIME_STATUSES = new Set(["online", "declared-offline", "degraded", "unavailable"]);

function registryString(object, key, context) {
  const value = object && typeof object === "object" ? object[key] : null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`StarIntel server: ${context}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function registryStringList(object, key, context) {
  const value = object && typeof object === "object" ? object[key] : null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`StarIntel server: ${context}.${key} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function normalizeActorContract(contract, context) {
  return {
    targets: registryStringList(contract, "targets", context),
    documents: registryStringList(contract, "documents", context),
    messages: registryStringList(contract, "messages", context)
  };
}

function normalizeActorRegistryEntry(manifest, index = 0) {
  const context = `actor registry entry ${index}`;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`StarIntel server: ${context} must be an object`);
  }
  const resourceUri = registryString(manifest, "resourceUri", context);
  const resourceKind = registryString(manifest, "resourceKind", context);
  if (!["actor", "service"].includes(resourceKind)) {
    throw new Error(`StarIntel server: ${context}.resourceKind is unsupported`);
  }
  let parsedResource;
  try {
    parsedResource = new URL(resourceUri);
  } catch {
    throw new Error(`StarIntel server: ${context}.resourceUri is not a canonical STAR URI`);
  }
  if (
    parsedResource.protocol !== "star:" ||
    !parsedResource.hostname ||
    parsedResource.username ||
    parsedResource.password ||
    parsedResource.port ||
    parsedResource.search ||
    parsedResource.hash ||
    !parsedResource.pathname.startsWith(`/${resourceKind}/`) ||
    parsedResource.pathname.length <= `/${resourceKind}/`.length ||
    parsedResource.pathname.includes("//") ||
    parsedResource.pathname.includes("/./") ||
    parsedResource.pathname.includes("/../")
  ) {
    throw new Error(`StarIntel server: ${context}.resourceUri is not a canonical STAR URI`);
  }
  const semantic = manifest.semantic;
  const provenance = manifest.provenance;
  const name = registryString(semantic, "name", `${context}.semantic`);
  const version = registryString(semantic, "version", `${context}.semantic`);
  const digest = registryString(semantic, "digest", `${context}.semantic`);
  const sourcePackage = registryString(provenance, "sourcePackage", `${context}.provenance`);
  const status = registryString(manifest, "status", context);
  if (!ACTOR_RUNTIME_STATUSES.has(status)) {
    throw new Error(`StarIntel server: ${context}.status is unsupported`);
  }
  if (typeof manifest.ready !== "boolean") {
    throw new Error(`StarIntel server: ${context}.ready must be a boolean`);
  }
  if (manifest.operatorVisible !== true) {
    throw new Error(`StarIntel server: ${context}.operatorVisible must be true`);
  }
  const observedAt =
    manifest.observedAt == null ? null : registryString(manifest, "observedAt", context);
  const accepts = normalizeActorContract(manifest.accepts, `${context}.accepts`);
  const produces = normalizeActorContract(manifest.produces, `${context}.produces`);
  const capabilities = registryStringList(manifest, "capabilities", context);
  return {
    id: `star-runtime:${resourceUri}`,
    actorId: name,
    label: name,
    description: `${resourceKind} ${name}@${version} from ${sourcePackage}`,
    source: "",
    serverManaged: true,
    readOnly: true,
    resourceUri,
    resourceKind,
    semantic: { name, version, digest },
    accepts,
    produces,
    capabilities,
    sourcePackage,
    status,
    ready: manifest.ready,
    alive: status === "online" && manifest.ready,
    observedAt,
    manifest: structuredClone(manifest)
  };
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

export async function listStarIntelActors(configuration) {
  const response = await request(configuration, "/v1/actors");
  if (response?.data?.schema !== ACTOR_REGISTRY_SCHEMA) {
    throw new Error(`StarIntel server: unsupported actor registry schema`);
  }
  const actors = response?.data?.actors;
  if (!Array.isArray(actors)) {
    throw new Error("StarIntel server: actor discovery response did not contain data.actors");
  }
  if (!Number.isInteger(response.data.count) || response.data.count !== actors.length) {
    throw new Error("StarIntel server: actor registry count did not match data.actors");
  }
  return actors.map(normalizeActorRegistryEntry);
}

export async function submitTargetToServer(configuration, target) {
  const document = toCanonicalDocument(target, { allowLegacy090: true });
  if (document.dtype !== "target")
    throw new Error("Only target documents can be submitted as targets");
  const actor = document.actor;
  if (!actor) throw new Error("Target actor is required");
  // The server target command is distinct from a canonical Target document.
  // 0.10.1 options are a map; v1 currently accepts an array. Only the empty
  // case has a lossless meaning until the server defines a map adapter.
  if (document.options && Object.keys(document.options).length) {
    throw new Error("Target options map has no defined server v1 array mapping");
  }
  const command = {
    actor,
    target: document.target,
    dataset: document.dataset,
    delay: document.delay ?? 1,
    recurring: document.recurring ?? false,
    options: [],
    idempotency_key: document.id
  };
  try {
    return await request(configuration, "/api/v1/targets", {
      method: "POST",
      headers: { "Idempotency-Key": document.id },
      body: JSON.stringify(command)
    });
  } catch (error) {
    if (!/404|not found/i.test(error.message)) throw error;
    return request(configuration, `/new/target/${encodeURIComponent(actor)}`, {
      method: "POST",
      body: JSON.stringify(document)
    });
  }
}

export const starIntelServerInternals = Object.freeze({
  serverUrl,
  authorization,
  normalizeActorRegistryEntry
});
