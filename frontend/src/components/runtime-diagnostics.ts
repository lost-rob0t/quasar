const STORAGE_KEY = "quasar:runtime-diagnostics:v1";
const EVENT_NAME = "quasar:runtime-diagnostics";
const MAX_ENTRIES = 250;
const DEDUPE_WINDOW_MS = 10_000;

export type RuntimeDiagnosticLevel = "error" | "warning" | "info";

export interface RuntimeDiagnosticEntry {
  id: string;
  timestamp: string;
  level: RuntimeDiagnosticLevel;
  source: string;
  message: string;
  details: string;
  count: number;
}

let volatileEntries: RuntimeDiagnosticEntry[] = [];

export function redactDiagnostic(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|secret|password|api[_-]?key|session)=)[^\s&#]+/gi, "$1[redacted]")
    .replace(
      /\b(authorization|password|secret|token|api[_-]?key|session)(\s*[=:]\s*)[^\s,;}]+/gi,
      "$1$2[redacted]"
    );
}

function nextId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeEntries(value: unknown): RuntimeDiagnosticEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => entry as Partial<RuntimeDiagnosticEntry>)
    .filter((entry) => typeof entry.message === "string" && typeof entry.source === "string")
    .map((entry) => ({
      id: String(entry.id || nextId()),
      timestamp: String(entry.timestamp || new Date().toISOString()),
      level:
        entry.level === "warning" || entry.level === "info" || entry.level === "error"
          ? entry.level
          : "error",
      source: String(entry.source),
      message: String(entry.message),
      details: String(entry.details || ""),
      count: Math.max(1, Number(entry.count || 1))
    }))
    .slice(0, MAX_ENTRIES);
}

export function readRuntimeDiagnostics(): RuntimeDiagnosticEntry[] {
  if (typeof window === "undefined") return [...volatileEntries];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    volatileEntries = normalizeEntries(parsed);
  } catch {
    // Keep the in-memory copy when localStorage is unavailable or corrupted.
  }
  return [...volatileEntries];
}

function persist(entries: RuntimeDiagnosticEntry[]): void {
  volatileEntries = entries.slice(0, MAX_ENTRIES);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(volatileEntries));
  } catch {
    // Diagnostics remain available for the current session when persistence is blocked.
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function recordRuntimeDiagnostic({
  level = "error",
  source,
  message,
  details = ""
}: {
  level?: RuntimeDiagnosticLevel;
  source: string;
  message: string;
  details?: string;
}): RuntimeDiagnosticEntry {
  const now = new Date();
  const safeSource = redactDiagnostic(String(source || "runtime"));
  const safeMessage = redactDiagnostic(String(message || "Unknown runtime error"));
  const safeDetails = redactDiagnostic(String(details || ""));
  const entries = readRuntimeDiagnostics();
  const latest = entries[0];
  const duplicate =
    latest &&
    latest.level === level &&
    latest.source === safeSource &&
    latest.message === safeMessage &&
    latest.details === safeDetails &&
    now.getTime() - new Date(latest.timestamp).getTime() <= DEDUPE_WINDOW_MS;

  if (duplicate) {
    const updated = { ...latest, timestamp: now.toISOString(), count: latest.count + 1 };
    persist([updated, ...entries.slice(1)]);
    return updated;
  }

  const entry: RuntimeDiagnosticEntry = {
    id: nextId(),
    timestamp: now.toISOString(),
    level,
    source: safeSource,
    message: safeMessage,
    details: safeDetails,
    count: 1
  };
  persist([entry, ...entries]);
  return entry;
}

export function clearRuntimeDiagnostics(): void {
  persist([]);
}

export function subscribeRuntimeDiagnostics(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT_NAME, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT_NAME, listener);
    window.removeEventListener("storage", listener);
  };
}
