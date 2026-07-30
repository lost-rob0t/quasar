import {
  DEFAULT_MELISSA_CONFIG,
  loadMelissaConfig,
  saveMelissaConfig,
  clearMelissaConfig
} from "./melissa-browser-config";

export const ACTOR_CONFIGURATION_STORAGE_KEY = "quasar:actor-configuration:v1";

export const MELISSA_ACTOR_PREFIX = "quasar.actor.melissa-";

export const MELISSA_CONFIGURATION_FIELDS = Object.freeze([
  {
    key: "licenseKey",
    label: "License Key Using Credits or subscription license key",
    type: "secret",
    required: true,
    placeholder: "Paste only the key value from Melissa License Information"
  },
  {
    key: "transmissionReference",
    label: "Transmission reference",
    type: "text",
    placeholder: "Quasar"
  },
  { key: "defaultCountry", label: "Default country", type: "text", placeholder: "US" },
  {
    key: "consumerAction",
    label: "Consumer action",
    type: "select",
    options: ["Check", "Verify", "Append", "Move"]
  },
  { key: "identityAction", label: "Identity action", type: "select", options: ["Check", "Screen"] },
  { key: "maxRecords", label: "Search record limit", type: "number", min: 1, max: 100 },
  { key: "matchLevel", label: "Search match level", type: "number", min: 1, max: 10 },
  { key: "reverseDistance", label: "Reverse distance", type: "number", min: 1, max: 100 },
  { key: "reverseRecords", label: "Reverse record limit", type: "number", min: 1, max: 100 },
  { key: "consumerOptions", label: "Consumer options", type: "text" },
  { key: "consumerColumns", label: "Consumer columns", type: "text" },
  { key: "personatorColumns", label: "Personator Search columns", type: "text" },
  { key: "personatorOptions", label: "Personator Search options", type: "text" },
  { key: "addressOptions", label: "Global Address options", type: "text" },
  { key: "nameOptions", label: "Global Name options", type: "text" },
  { key: "phoneOptions", label: "Global Phone options", type: "text" },
  { key: "emailOptions", label: "Global Email options", type: "text" },
  { key: "ipColumns", label: "Global IP columns", type: "text" },
  {
    key: "proxyTemplate",
    label: "CORS proxy template",
    type: "text",
    placeholder: "https://proxy.example/fetch?url={url}"
  }
]);

function storage() {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function readRegistry() {
  try {
    const raw = storage()?.getItem(ACTOR_CONFIGURATION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRegistry(registry) {
  storage()?.setItem(ACTOR_CONFIGURATION_STORAGE_KEY, JSON.stringify(registry));
}

export function isMelissaActor(actor) {
  return String(actor?.id || "").startsWith(MELISSA_ACTOR_PREFIX);
}

export function actorConfigurationId(actor) {
  return isMelissaActor(actor) ? "melissa" : String(actor?.id || "").trim();
}

export function loadActorConfiguration(actor) {
  if (isMelissaActor(actor)) return loadMelissaConfig();
  const id = actorConfigurationId(actor);
  const value = readRegistry()[id];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function saveActorConfiguration(actor, value) {
  const normalized = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (isMelissaActor(actor)) return saveMelissaConfig(normalized);
  const id = actorConfigurationId(actor);
  if (!id) throw new TypeError("Actor id is required for configuration");
  const registry = readRegistry();
  registry[id] = normalized;
  writeRegistry(registry);
  return normalized;
}

export function clearActorConfiguration(actor) {
  if (isMelissaActor(actor)) {
    clearMelissaConfig();
    return;
  }
  const id = actorConfigurationId(actor);
  const registry = readRegistry();
  delete registry[id];
  writeRegistry(registry);
}

export function actorConfigurationDefinition(actor) {
  if (isMelissaActor(actor)) {
    return {
      id: "melissa",
      label: "Melissa actor pack",
      description: "Shared credentials and service defaults for every Melissa actor.",
      fields: MELISSA_CONFIGURATION_FIELDS,
      defaults: DEFAULT_MELISSA_CONFIG
    };
  }
  return {
    id: actorConfigurationId(actor),
    label: actor?.label || actor?.id || "Actor",
    description:
      actor?.description || "JSON configuration passed to the actor as context.configuration.",
    fields: [],
    defaults: {}
  };
}

export function actorConfigurationStatus(actor) {
  const configuration = loadActorConfiguration(actor);
  if (isMelissaActor(actor) && !String(configuration.licenseKey || "").trim()) {
    return {
      configured: false,
      missing: ["License Key Using Credits or subscription license key"],
      configuration
    };
  }
  return { configured: true, missing: [], configuration };
}
