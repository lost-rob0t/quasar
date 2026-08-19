import { ChevronRight, Redo2, Undo2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuasar } from "../store";
import { navigation } from "../ui-core/navigation";
import { useUiRuntime } from "../ui-core/runtime";

const OPEN_DISTANCE = 28;
const CLOSE_DISTANCE = 44;

export default function MobileGestureMenu({ open, onOpenChange }) {
  const pointer = useRef(null);
  const location = useLocation();
  const runtime = useUiRuntime();
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
              <div className="mobile-gesture-heading">
                <span className="mobile-gesture-brand-mark" aria-hidden="true">
                  ✦
                </span>
                <span>
                  <strong>Quasar</strong>
                  <small>{runtime.workspaceLabel}</small>
                </span>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close navigation"
                onClick={() => onOpenChange(false)}
              >
                <X size={18} />
              </button>
            </header>

            <div className="mobile-gesture-section-label">Navigation</div>
            <nav className="mobile-gesture-grid" aria-label="Mobile navigation">
              {navigation.map(({ to, label, Icon, match }) => {
                const active = match(location.pathname);
                return (
                  <Link
                    key={to}
                    to={to}
                    className={active ? "mobile-gesture-link active" : "mobile-gesture-link"}
                    aria-current={active ? "page" : undefined}
                    onClick={() => onOpenChange(false)}
                  >
                    <span className="mobile-gesture-link-icon">
                      <Icon size={19} aria-hidden="true" />
                    </span>
                    <strong>{label}</strong>
                    <ChevronRight
                      className="mobile-gesture-link-chevron"
                      size={16}
                      aria-hidden="true"
                    />
                  </Link>
                );
              })}
            </nav>

            <div className="mobile-gesture-section-label">History</div>
            <div className="mobile-gesture-actions" aria-label="History actions">
              <button
                className="button"
                type="button"
                disabled={!canUndo}
                onClick={() => runHistory(undo)}
              >
                <Undo2 size={17} /> Undo
              </button>
              <button
                className="button"
                type="button"
                disabled={!canRedo}
                onClick={() => runHistory(redo)}
              >
                <Redo2 size={17} /> Redo
              </button>
            </div>
            <small className="mobile-gesture-hint">Swipe down to close</small>
          </section>
        </div>
      )}
    </div>
  );
}
