import {
  PRO_ACTOR_MANIFEST_CAPABILITY,
  PRO_ACTOR_SUBMIT_CAPABILITY,
  normalizeProActorManifest
} from "./pro-actors.js";

export function normalizeProIntegrationMode(value) {
  return ["off", "auto", "on"].includes(value) ? value : "auto";
}

// Session grants are the supported entitlement projection. Successful discovery
// also proves the host implements the integration; grants alone cannot do that.
export async function discoverProIntegration(capabilities, manifests, isCurrent = () => true) {
  try {
    const granted = await capabilities();
    if (!isCurrent()) return { status: "unavailable", manifests: [] };
    if (
      !Array.isArray(granted) ||
      !granted.includes(PRO_ACTOR_MANIFEST_CAPABILITY) ||
      !granted.includes(PRO_ACTOR_SUBMIT_CAPABILITY)
    ) {
      return { status: "unavailable", manifests: [] };
    }
    const documents = await manifests();
    if (!Array.isArray(documents)) throw new Error("Invalid Pro discovery response");
    return {
      status: "available",
      manifests: documents
        .map(normalizeProActorManifest)
        .filter(Boolean)
        .sort((left, right) => left.id.localeCompare(right.id))
    };
  } catch (cause) {
    return { status: "error", manifests: [], error: cause?.message || "Pro discovery failed" };
  }
}

export function proIntegrationView(preference, connected, discovery) {
  const mode = normalizeProIntegrationMode(preference);
  const available = mode !== "off" && connected && discovery?.status === "available";
  return {
    visible: mode === "on" || (mode === "auto" && available),
    available,
    canSubmit: available,
    loading: mode !== "off" && connected && !discovery,
    manifests: available ? discovery.manifests : [],
    error: connected && mode !== "off" ? discovery?.error || "" : ""
  };
}
