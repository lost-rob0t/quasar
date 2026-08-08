export const MELISSA_CONFIG_STORAGE_KEY = "quasar:melissa-actor-config:v1";

export const DEFAULT_MELISSA_CONFIG = Object.freeze({
  licenseKey: "",
  transmissionReference: "Quasar",
  defaultCountry: "US",
  consumerAction: "Check",
  identityAction: "Check",
  consumerOptions: "",
  consumerColumns: "",
  personatorColumns:
    "PreviousAddress,DateOfBirth,DateOfDeath,Email,MelissaIdentityKey,MoveDate,Phone,Suffix",
  personatorOptions:
    "SearchType:Auto,SearchConditions:progressive,RecordsPerPage:10,MaxEmail:10,MaxPhone:10",
  maxRecords: 10,
  matchLevel: 10,
  reverseDistance: 10,
  reverseRecords: 10,
  addressOptions: "OutputGeo:ON",
  nameOptions: "",
  phoneOptions: "VerifyPhone:Express",
  emailOptions: "VerifyMailbox:Express,DomainCorrection:OFF,TimeToWait:25",
  ipColumns: "",
  proxyTemplate: ""
});

const MELISSA_HOSTS = new Set([
  "personatorsearch.melissadata.net",
  "search.melissadata.net",
  "personator.melissadata.net",
  "globalpersonator.melissadata.net",
  "reversegeo.melissadata.net",
  "property.melissadata.net",
  "address.melissadata.net",
  "globalname.melissadata.net",
  "globalphone.melissadata.net",
  "globalemail.melissadata.net",
  "globalip.melissadata.net"
]);

const MELISSA_KEY_LABEL =
  /^(?:melissa\s+)?(?:api\s+key|license\s+key(?:\s+using\s+credits)?|customer\s+id)\b(?:\s*[:=]\s*|\s+)/i;
const MELISSA_COPY_LABEL = /^(?:copy|copied)\b\s*/i;
const INVISIBLE_KEY_CHARACTERS = /[\u200b-\u200d\u2060\ufeff]/g;

let originalFetch = null;
let installed = false;

function finiteInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

export function normalizeMelissaLicenseKey(value) {
  let key = String(value ?? "")
    .replace(INVISIBLE_KEY_CHARACTERS, "")
    .trim();
  key = key.replace(MELISSA_KEY_LABEL, "").replace(MELISSA_COPY_LABEL, "").trim();
  if (
    key.length >= 2 &&
    ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(INVISIBLE_KEY_CHARACTERS, "").replace(/\s+/gu, "");
}

export function normalizeMelissaConfig(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    licenseKey: normalizeMelissaLicenseKey(input.licenseKey),
    transmissionReference: String(
      input.transmissionReference || DEFAULT_MELISSA_CONFIG.transmissionReference
    )
      .trim()
      .slice(0, 128),
    defaultCountry: String(input.defaultCountry || DEFAULT_MELISSA_CONFIG.defaultCountry)
      .trim()
      .toUpperCase()
      .slice(0, 3),
    consumerAction: ["Check", "Verify", "Append", "Move"].includes(input.consumerAction)
      ? input.consumerAction
      : DEFAULT_MELISSA_CONFIG.consumerAction,
    identityAction: ["Check", "Screen"].includes(input.identityAction)
      ? input.identityAction
      : DEFAULT_MELISSA_CONFIG.identityAction,
    consumerOptions: String(input.consumerOptions || "").trim(),
    consumerColumns: String(input.consumerColumns || "").trim(),
    personatorColumns: String(
      input.personatorColumns || DEFAULT_MELISSA_CONFIG.personatorColumns
    ).trim(),
    personatorOptions: String(
      input.personatorOptions || DEFAULT_MELISSA_CONFIG.personatorOptions
    ).trim(),
    maxRecords: finiteInteger(input.maxRecords, DEFAULT_MELISSA_CONFIG.maxRecords, 1, 100),
    matchLevel: finiteInteger(input.matchLevel, DEFAULT_MELISSA_CONFIG.matchLevel, 1, 10),
    reverseDistance: finiteInteger(
      input.reverseDistance,
      DEFAULT_MELISSA_CONFIG.reverseDistance,
      1,
      100
    ),
    reverseRecords: finiteInteger(
      input.reverseRecords,
      DEFAULT_MELISSA_CONFIG.reverseRecords,
      1,
      100
    ),
    addressOptions: String(input.addressOptions || "").trim(),
    nameOptions: String(input.nameOptions || "").trim(),
    phoneOptions: String(input.phoneOptions || "").trim(),
    emailOptions: String(input.emailOptions || "").trim(),
    ipColumns: String(input.ipColumns || "").trim(),
    proxyTemplate: String(input.proxyTemplate || "").trim()
  };
}

function storage() {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function loadMelissaConfig() {
  try {
    const raw = storage()?.getItem(MELISSA_CONFIG_STORAGE_KEY);
    return normalizeMelissaConfig(raw ? JSON.parse(raw) : DEFAULT_MELISSA_CONFIG);
  } catch {
    return normalizeMelissaConfig(DEFAULT_MELISSA_CONFIG);
  }
}

export function saveMelissaConfig(value) {
  const normalized = normalizeMelissaConfig(value);
  storage()?.setItem(MELISSA_CONFIG_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function clearMelissaConfig() {
  storage()?.removeItem(MELISSA_CONFIG_STORAGE_KEY);
}

function requestUrl(input) {
  if (typeof input === "string" || input instanceof URL) return new URL(String(input));
  if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url);
  return null;
}

function add(url, key, value) {
  if (value !== undefined && value !== null && String(value).trim() && !url.searchParams.has(key)) {
    url.searchParams.set(key, String(value));
  }
}

function configureMelissaUrl(url, config) {
  add(url, "id", config.licenseKey);
  add(url, "t", config.transmissionReference);

  const path = url.pathname.toLowerCase();
  if (
    [
      "personator.melissadata.net",
      "globalpersonator.melissadata.net",
      "address.melissadata.net",
      "globalname.melissadata.net",
      "globalphone.melissadata.net"
    ].includes(url.hostname)
  ) {
    add(url, "ctry", config.defaultCountry);
  } else if (url.hostname === "property.melissadata.net") {
    add(url, "country", config.defaultCountry);
  }

  if (url.hostname === "search.melissadata.net") {
    add(url, "maxrecords", config.maxRecords);
    add(url, "matchlevel", config.matchLevel);
  } else if (url.hostname === "reversegeo.melissadata.net") {
    add(url, "dist", config.reverseDistance);
    add(url, "recs", config.reverseRecords);
  } else if (url.hostname === "personator.melissadata.net") {
    add(url, "act", config.consumerAction);
    add(url, "opt", config.consumerOptions);
    add(url, "cols", config.consumerColumns);
  } else if (url.hostname === "globalpersonator.melissadata.net") {
    add(url, "act", config.identityAction);
  } else if (url.hostname === "personatorsearch.melissadata.net") {
    add(url, "cols", config.personatorColumns);
    add(url, "opt", config.personatorOptions);
  } else if (url.hostname === "address.melissadata.net") {
    add(url, "opt", config.addressOptions);
  } else if (url.hostname === "globalname.melissadata.net") {
    add(url, "opt", config.nameOptions);
  } else if (url.hostname === "globalphone.melissadata.net") {
    add(url, "opt", config.phoneOptions);
  } else if (url.hostname === "globalemail.melissadata.net") {
    add(url, "opt", config.emailOptions);
  } else if (url.hostname === "globalip.melissadata.net" && path.includes("iplocation")) {
    add(url, "cols", config.ipColumns);
  }

  return url;
}

function proxiedUrl(url, template) {
  if (!template) return url.href;
  if (!template.includes("{url}")) throw new Error("Melissa proxy template must contain {url}");
  return template.replaceAll("{url}", encodeURIComponent(url.href));
}

export function installMelissaFetchInterceptor() {
  if (installed || typeof globalThis.fetch !== "function") return;
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (!url || !MELISSA_HOSTS.has(url.hostname.toLowerCase())) return originalFetch(input, init);

    const config = loadMelissaConfig();
    if (!config.licenseKey) {
      throw new Error("Configure a Melissa license key before running Melissa actors");
    }

    const configured = configureMelissaUrl(url, config);
    return originalFetch(proxiedUrl(configured, config.proxyTemplate), init);
  };
  installed = true;
}

export function uninstallMelissaFetchInterceptor() {
  if (!installed || !originalFetch) return;
  globalThis.fetch = originalFetch;
  originalFetch = null;
  installed = false;
}
