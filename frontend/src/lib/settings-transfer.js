export const SETTINGS_EXPORT_VERSION = 1;

const SECRET_KEYS = new Set(["couchPassword", "serverPassword", "serverToken", "rabbitPassword"]);

export function exportableSettings(settings = {}) {
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => !key.startsWith("_") && !SECRET_KEYS.has(key))
  );
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
