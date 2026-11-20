// Forgejo-backed actor registry (default: starintel-pro-actors on
// git.starintel.actor). The control plane relays the fetch (no CORS), and
// each JSONL manifest becomes a display-only, server-managed actor entry:
// these actors execute on the pro-actor fleet, not in the browser.

export const DEFAULT_REGISTRY_URL =
  "https://git.starintel.actor/api/v1/repos/starintel-labs/starintel-pro-actors/raw/registry/actors.jsonl?ref=registry/actors";

export function normalizeRegistryActor(entry, index = 0) {
  if (!entry || typeof entry !== "object") {
    throw new TypeError(`registry entry ${index} must be an object`);
  }
  const actorId = String(entry.actor_id || "").trim();
  if (!actorId) throw new TypeError(`registry entry ${index} is missing actor_id`);
  const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities.map(String) : [];
  const inputDtypes = Array.isArray(entry.input_dtypes) ? entry.input_dtypes.map(String) : [];
  const outputDtypes = Array.isArray(entry.output_dtypes) ? entry.output_dtypes.map(String) : [];
  const auth =
    entry.authorization && typeof entry.authorization === "object" ? entry.authorization : {};
  const credentials = auth && typeof auth.credentials === "string" ? auth.credentials : "";
  return {
    id: `pro-actor:${actorId}`,
    actorId,
    label: actorId,
    description:
      `${String(entry.actor_type || "actor")} actor` +
      (credentials ? ` (needs ${credentials})` : "") +
      (capabilities.length ? ` · ${capabilities.slice(0, 3).join(", ")}` : ""),
    version: 1,
    accepts: inputDtypes.length ? inputDtypes : ["*"],
    triggers: [],
    capabilities,
    produces: outputDtypes,
    runtime: "pro-actor-fleet",
    source: "",
    serverManaged: true,
    readOnly: true,
    sourceRepository: "starintel-pro-actors@forgejo",
    observedAt: typeof entry.observedAt === "string" ? entry.observedAt : null
  };
}

export function parseRegistryJsonl(text) {
  const actors = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    actors.push(JSON.parse(trimmed));
  }
  return actors.map(normalizeRegistryActor);
}
