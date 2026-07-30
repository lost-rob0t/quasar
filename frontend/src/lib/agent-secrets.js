const SECRET_PREFIX = "quasar:provider-secret:";
const memory = new Map();

function sessionStorageBackend() {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage;
}

function legacyPersistentStorage() {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function key(providerId) {
  return `${SECRET_PREFIX}${providerId}`;
}

function credentialScope(configuration) {
  if (!configuration || typeof configuration !== "object") return null;
  const rawUrl = configuration.baseUrl || configuration.url;
  if (!rawUrl) return null;
  const url = new URL(String(rawUrl));
  return JSON.stringify({
    type: String(configuration.type || configuration.recordType || ""),
    origin: url.origin,
    path: url.pathname.replace(/\/+$/, "") || "/"
  });
}

function purgeLegacy(providerId) {
  legacyPersistentStorage()?.removeItem(key(providerId));
}

function encodeSecret(value, configuration) {
  return JSON.stringify({ value, scope: credentialScope(configuration) });
}

function decodeSecret(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      value: String(parsed.value || ""),
      scope: parsed.scope === null ? null : String(parsed.scope || "")
    };
  } catch {
    return { value: String(raw), scope: null };
  }
}

export function setProviderSecret(providerId, secret, configuration = null) {
  const value = String(secret || "");
  if (!value) throw new TypeError("Provider key is required");

  const name = key(providerId);
  const encoded = encodeSecret(value, configuration);
  purgeLegacy(providerId);
  memory.set(name, encoded);
  sessionStorageBackend()?.setItem(name, encoded);
}

export function getProviderSecret(providerId, configuration = null) {
  const name = key(providerId);
  purgeLegacy(providerId);
  const record = decodeSecret(sessionStorageBackend()?.getItem(name) || memory.get(name));
  if (!record?.value) return "";

  const expectedScope = credentialScope(configuration);
  if (expectedScope && record.scope !== expectedScope) return "";
  return record.value;
}

export function deleteProviderSecret(providerId) {
  const name = key(providerId);
  memory.delete(name);
  sessionStorageBackend()?.removeItem(name);
  purgeLegacy(providerId);
}

export function hasProviderSecret(providerId, configuration = null) {
  return Boolean(getProviderSecret(providerId, configuration));
}

export function maskSecret(secret) {
  const value = String(secret || "");
  if (!value) return "";
  return `••••••••${value.length > 4 ? value.slice(-4) : ""}`;
}
