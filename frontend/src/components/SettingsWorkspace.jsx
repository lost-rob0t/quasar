import { useEffect, useState } from "react";
import {
  Bug,
  CheckCircle2,
  CircleAlert,
  Clipboard,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff
} from "lucide-react";
import { getControlPlane } from "../control-plane";
import {
  clearRuntimeDiagnostics,
  readRuntimeDiagnostics,
  subscribeRuntimeDiagnostics
} from "./runtime-diagnostics";
import { SettingsPage } from "./ImportSettings";

function levelIcon(level) {
  if (level === "info") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (level === "warning") return <CircleAlert size={16} aria-hidden="true" />;
  return <Bug size={16} aria-hidden="true" />;
}

function formatTimestamp(timestamp) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "short",
      timeStyle: "medium"
    }).format(new Date(timestamp));
  } catch {
    return timestamp;
  }
}

export default function SettingsWorkspace() {
  const [entries, setEntries] = useState(() => readRuntimeDiagnostics());
  const [connection, setConnection] = useState({
    phase: "connecting",
    connected: false,
    synchronized: false,
    attempts: 0
  });

  function refresh() {
    setEntries(readRuntimeDiagnostics());
  }

  useEffect(() => subscribeRuntimeDiagnostics(refresh), []);
  useEffect(() => {
    const client = getControlPlane();
    if (!client) return undefined;
    return client.onConnectionStateChange(setConnection);
  }, []);

  async function copyLog() {
    const payload = entries
      .map(
        (entry) =>
          `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.source}: ${entry.message}` +
          `${entry.count > 1 ? ` (x${entry.count})` : ""}` +
          `${entry.details ? `\n${entry.details}` : ""}`
      )
      .join("\n\n");
    await navigator.clipboard.writeText(payload || "No runtime diagnostics recorded.");
  }

  function clearLog() {
    clearRuntimeDiagnostics();
    refresh();
  }

  const online = connection.connected && connection.synchronized;

  return (
    <>
      <SettingsPage />
      <section className="panel runtime-log-panel" aria-labelledby="runtime-log-heading">
        <div className="section-heading runtime-log-heading">
          <div>
            <h2 id="runtime-log-heading">
              <Bug size={19} aria-hidden="true" /> Runtime error log
            </h2>
            <p className="muted">
              Redacted browser and Common Lisp control-plane failures persist across reloads.
            </p>
          </div>
          <span className={`runtime-connection ${online ? "online" : "offline"}`}>
            {online ? <Wifi size={15} /> : <WifiOff size={15} />}
            {online
              ? "WebSocket connected"
              : `${connection.phase} · ${connection.attempts} retries`}
          </span>
        </div>

        <div className="runtime-log-toolbar">
          <span>{entries.length} retained events · newest first</span>
          <div className="button-row">
            <button className="button small" type="button" onClick={refresh}>
              <RefreshCw size={14} /> Refresh
            </button>
            <button className="button small" type="button" onClick={copyLog}>
              <Clipboard size={14} /> Copy log
            </button>
            <button className="button danger small" type="button" onClick={clearLog}>
              <Trash2 size={14} /> Clear
            </button>
          </div>
        </div>

        <div className="runtime-log-list" role="log" aria-live="polite">
          {entries.map((entry) => (
            <details className={`runtime-log-entry ${entry.level}`} key={entry.id}>
              <summary>
                <span className="runtime-log-level">{levelIcon(entry.level)}</span>
                <span className="runtime-log-source">{entry.source}</span>
                <strong>{entry.message}</strong>
                {entry.count > 1 && <span className="runtime-log-count">×{entry.count}</span>}
                <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
              </summary>
              {entry.details ? (
                <pre>{entry.details}</pre>
              ) : (
                <p className="muted">No extra details.</p>
              )}
            </details>
          ))}
          {!entries.length && (
            <div className="runtime-log-empty">
              <CheckCircle2 size={22} aria-hidden="true" />
              <span>No runtime failures have been recorded.</span>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
