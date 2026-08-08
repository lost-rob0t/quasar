export const SETTINGS_EXPORT_VERSION = 1;

const SECRET_KEY =
  /(?:authorization|credential|password|passwd|secret|token|user(?:name)?|api[-_]?key)$/i;

function safeValue(value) {
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith("_") && !SECRET_KEY.test(key))
        .map(([key, nested]) => [key, safeValue(nested)])
    );
  }
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function exportableSettings(settings = {}) {
  return safeValue(settings);
}

export function createSettingsExport(settings = {}) {
  return {
    type: "quasar-settings",
    version: SETTINGS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: exportableSettings(settings)
  };
}

export function parseSettingsImport(text) {
  const value = JSON.parse(text);
  if (!value || value.type !== "quasar-settings" || value.version !== SETTINGS_EXPORT_VERSION) {
    throw new Error("Import failed: unsupported settings file");
  }
  if (!value.settings || Array.isArray(value.settings) || typeof value.settings !== "object") {
    throw new Error("Import failed: settings object is missing");
  }
  return exportableSettings(value.settings);
}
