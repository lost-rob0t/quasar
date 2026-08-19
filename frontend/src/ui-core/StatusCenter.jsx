import { CheckCircle2, ChevronDown, CircleAlert, PlugZap, ServerOff, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuasar } from "../store";
import { useUiRuntime } from "./runtime";

const BAD = new Set(["error", "denied", "failed", "offline", "disconnected"]);
const BUSY = new Set(["connecting", "retrying", "active", "reconnecting"]);
const GOOD = new Set(["online", "connected", "synced", "success", "ready"]);

function tone(status) {
  if (BAD.has(status)) return "danger";
  if (BUSY.has(status)) return "warning";
  if (GOOD.has(status)) return "success";
  return "neutral";
}

function overall(items) {
  if (items.some((entry) => entry.critical && BAD.has(entry.status))) return "danger";
  if (items.some((entry) => BAD.has(entry.status))) return "danger";
  if (items.some((entry) => BUSY.has(entry.status))) return "warning";
  if (items.every((entry) => GOOD.has(entry.status) || entry.status === "offline")) return "success";
  return "neutral";
}

function overallLabel(value, runtimeLabel) {
  if (value === "danger") return "Degraded";
  if (value === "warning") return "Connecting";
  if (value === "success") return runtimeLabel;
  return "Status";
}

export default function StatusCenter() {
  const runtime = useUiRuntime();
  const quasar = useQuasar();
  const [open, setOpen] = useState(false);
  const items = useMemo(() => runtime.health(quasar), [runtime, quasar]);
  const state = overall(items);

  return (
    <div className="status-center">
      <button
        className={`status-summary status-${state}`}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {state === "danger" ? <ServerOff size={15} /> : state === "success" ? <CheckCircle2 size={15} /> : <PlugZap size={15} />}
        <span>{overallLabel(state, runtime.label)}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <section className="status-popover" role="dialog" aria-label="Runtime status">
          <header>
            <div>
              <strong>Runtime status</strong>
              <span>{runtime.workspaceLabel}</span>
            </div>
            <button className="icon-button" type="button" aria-label="Close runtime status" onClick={() => setOpen(false)}>
              <X size={15} />
            </button>
          </header>
          <div className="status-list">
            {items.map((entry) => (
              <div className="status-row" key={entry.id}>
                <span className={`status-dot status-dot-${tone(entry.status)}`} aria-hidden="true" />
                <div>
                  <strong>{entry.label}</strong>
                  <small>{entry.detail || entry.status}</small>
                </div>
                <span className={`status-state status-state-${tone(entry.status)}`}>{entry.status}</span>
              </div>
            ))}
          </div>
          {state === "danger" && (
            <footer>
              <CircleAlert size={14} /> Missing services disable only dependent capabilities.
            </footer>
          )}
        </section>
      )}
    </div>
  );
}
