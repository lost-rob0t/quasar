import { useEffect, useRef } from "react";
import {
  Activity,
  Bot,
  FilePlus2,
  FolderInput,
  Menu,
  Network,
  Redo2,
  Settings,
  TableProperties,
  Undo2,
  X
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useQuasar } from "../store";

const navigation = [
  { to: "/", label: "Home", Icon: Activity, end: true },
  { to: "/graph", label: "Graph", Icon: Network },
  { to: "/documents", label: "Docs", Icon: TableProperties },
  { to: "/documents/new", label: "Add", Icon: FilePlus2 },
  { to: "/agents", label: "Agents", Icon: Bot },
  { to: "/import", label: "Import", Icon: FolderInput },
  { to: "/settings", label: "Settings", Icon: Settings }
];

const OPEN_DISTANCE = 28;
const CLOSE_DISTANCE = 44;

export default function MobileGestureMenu({ open, onOpenChange }) {
  const pointer = useRef(null);
  const { canUndo, canRedo, undo, redo, setNotice } = useQuasar();

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => event.key === "Escape" && onOpenChange(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onOpenChange, open]);

  function beginGesture(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointer.current = { id: event.pointerId, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveLauncher(event) {
    if (pointer.current?.id !== event.pointerId) return;
    if (pointer.current.y - event.clientY >= OPEN_DISTANCE) {
      pointer.current = null;
      onOpenChange(true);
    }
  }

  function moveSheet(event) {
    if (pointer.current?.id !== event.pointerId) return;
    if (event.clientY - pointer.current.y >= CLOSE_DISTANCE) {
      pointer.current = null;
      onOpenChange(false);
    }
  }

  function endGesture(event) {
    if (pointer.current?.id === event.pointerId) pointer.current = null;
  }

  async function runHistory(action) {
    try {
      await action();
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  return (
    <div className={open ? "mobile-gesture-root open" : "mobile-gesture-root"}>
      <button
        className="mobile-gesture-launcher"
        type="button"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={() => onOpenChange(true)}
        onPointerDown={beginGesture}
        onPointerMove={moveLauncher}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        <span aria-hidden="true" />
      </button>

      {open && (
        <div
          className="mobile-gesture-backdrop"
          onPointerDown={(event) => event.target === event.currentTarget && onOpenChange(false)}
        >
          <section
            className="mobile-gesture-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            onPointerDown={beginGesture}
            onPointerMove={moveSheet}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
          >
            <header>
              <span className="mobile-gesture-grip" aria-hidden="true" />
              <strong>
                <Menu size={17} /> Menu
              </strong>
              <button
                className="icon-button"
                type="button"
                aria-label="Close navigation"
                onClick={() => onOpenChange(false)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="mobile-gesture-actions" aria-label="History actions">
              <button
                className="button"
                type="button"
                disabled={!canUndo}
                onClick={() => runHistory(undo)}
              >
                <Undo2 size={18} /> Undo
              </button>
              <button
                className="button"
                type="button"
                disabled={!canRedo}
                onClick={() => runHistory(redo)}
              >
                <Redo2 size={18} /> Redo
              </button>
            </div>
            <nav className="mobile-gesture-grid" aria-label="Mobile navigation">
              {navigation.map(({ to, label, Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    isActive ? "mobile-gesture-link active" : "mobile-gesture-link"
                  }
                  onClick={() => onOpenChange(false)}
                >
                  <Icon size={22} aria-hidden="true" />
                  <span>{label}</span>
                </NavLink>
              ))}
            </nav>
            <small>Swipe down to close</small>
          </section>
        </div>
      )}
    </div>
  );
}
