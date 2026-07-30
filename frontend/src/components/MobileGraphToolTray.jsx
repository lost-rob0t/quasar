import { useEffect, useState } from "react";
import {
  CircleMinus,
  Database,
  Eraser,
  Focus,
  FolderInput,
  LayoutGrid,
  Maximize2,
  Menu,
  Network,
  PanelLeftOpen,
  Plus,
  Search,
  Tags,
  Trash2
} from "lucide-react";
import { createPortal } from "react-dom";
import GraphSelectMenu from "./GraphSelectMenu.jsx";
import { useLocation, useNavigate } from "react-router-dom";

const MOBILE_QUERY = "(max-width: 850px)";

function selectControl(label) {
  return document.querySelector(`select[aria-label="${label}"]`);
}

function layoutControl() {
  return selectControl("Maltego graph layout") || selectControl("Graph layout");
}

function cycleControl(select) {
  if (!select?.options?.length) return;
  select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function hiddenGraphAction(label) {
  return document.querySelector(`.graph-canvas-actions [aria-label="${label}"]`);
}

function hiddenGraphModeAction(label) {
  return document.querySelector(`.graph-mode-actions [aria-label="${label}"]`);
}

function removeStrayEmptyStateCount() {
  document.querySelectorAll(".graph-empty-state .button-row").forEach((row) => {
    [...row.childNodes].forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === "0") node.remove();
    });
  });
}

function ToolButton({ label, Icon, disabled = false, pressed, onClick }) {
  return (
    <button
      type="button"
      className="graph-mobile-tool"
      role="menuitem"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={21} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

export default function MobileGraphToolTray() {
  const location = useLocation();
  const navigate = useNavigate();
  const graphRoute = location.pathname === "/graph";
  const [mobile, setMobile] = useState(() => window.matchMedia?.(MOBILE_QUERY).matches ?? false);
  const [stage, setStage] = useState(null);
  const [open, setOpen] = useState(false);
  const [datasetOpen, setDatasetOpen] = useState(false);
  const [focusDisabled, setFocusDisabled] = useState(true);
  const [removeDisabled, setRemoveDisabled] = useState(true);
  const [deleteDisabled, setDeleteDisabled] = useState(true);
  const [labelsOn, setLabelsOn] = useState(true);

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const query = window.matchMedia(MOBILE_QUERY);
    const sync = () => setMobile(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    if (!graphRoute || !mobile) {
      setStage(null);
      setOpen(false);
      setDatasetOpen(false);
      return undefined;
    }

    let frame = 0;
    const sync = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        removeStrayEmptyStateCount();
        const nextStage = document.querySelector(".graph-stage");
        setStage((current) => (current === nextStage ? current : nextStage));
        setFocusDisabled(Boolean(hiddenGraphAction("Focus selection")?.disabled));
        setRemoveDisabled(Boolean(hiddenGraphAction("Remove from graph")?.disabled));
        setDeleteDisabled(Boolean(hiddenGraphAction("Delete selected documents")?.disabled));
        setLabelsOn(hiddenGraphAction("Toggle labels")?.getAttribute("aria-pressed") === "true");
      });
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-pressed"]
    });
    sync();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [graphRoute, mobile]);

  useEffect(() => {
    if (!open && !datasetOpen) return undefined;
    const close = (event) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setDatasetOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [datasetOpen, open]);

  if (!graphRoute || !mobile || !stage) return null;

  const run = (action) => {
    action();
    setOpen(false);
  };

  return createPortal(
    <>
      <div className="graph-mobile-primary-actions" aria-label="Graph primary actions">
        <button
          type="button"
          className="graph-mobile-primary-button"
          aria-label="Graph tools"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Menu size={23} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="graph-mobile-primary-button"
          aria-label="Add graph document"
          onClick={() => hiddenGraphAction("Add graph document")?.click()}
        >
          <Plus size={23} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="graph-mobile-primary-button"
          aria-label="Import"
          onClick={() => navigate("/import")}
        >
          <FolderInput size={22} aria-hidden="true" />
        </button>
      </div>

      {open && (
        <>
          <button
            type="button"
            className="graph-mobile-tools-backdrop"
            aria-label="Close graph tools"
            onClick={() => setOpen(false)}
          />
          <div className="graph-mobile-tools-tray" role="menu" aria-label="Graph tools">
            <ToolButton
              label="Navigation"
              Icon={PanelLeftOpen}
              onClick={() =>
                run(() => document.querySelector('button[aria-label="Open menu"]')?.click())
              }
            />
            <ToolButton
              label="Search"
              Icon={Search}
              onClick={() => run(() => hiddenGraphModeAction("Search graph")?.click())}
            />
            <ToolButton
              label="Graph"
              Icon={Network}
              onClick={() => run(() => cycleControl(selectControl("Active graph")))}
            />
            <ToolButton
              label="Dataset"
              Icon={Database}
              onClick={() => {
                setOpen(false);
                setDatasetOpen(true);
              }}
            />
            <ToolButton
              label="Layout"
              Icon={LayoutGrid}
              onClick={() => run(() => cycleControl(layoutControl()))}
            />
            <ToolButton
              label="Fit"
              Icon={Maximize2}
              onClick={() => run(() => hiddenGraphAction("Fit graph")?.click())}
            />
            <ToolButton
              label="Focus"
              Icon={Focus}
              disabled={focusDisabled}
              onClick={() => run(() => hiddenGraphAction("Focus selection")?.click())}
            />
            <ToolButton
              label="Labels"
              Icon={Tags}
              pressed={labelsOn}
              onClick={() => run(() => hiddenGraphAction("Toggle labels")?.click())}
            />
            <ToolButton
              label="Clear"
              Icon={Eraser}
              onClick={() => run(() => hiddenGraphAction("Clear graph")?.click())}
            />
            <ToolButton
              label="Remove"
              Icon={CircleMinus}
              disabled={removeDisabled}
              onClick={() => run(() => hiddenGraphAction("Remove from graph")?.click())}
            />
            <ToolButton
              label="Delete"
              Icon={Trash2}
              disabled={deleteDisabled}
              onClick={() => run(() => hiddenGraphAction("Delete selected documents")?.click())}
            />
          </div>
        </>
      )}
      <GraphSelectMenu
        open={datasetOpen}
        selectLabel="Dataset filter"
        title="Dataset"
        listLabel="Datasets"
        onClose={() => setDatasetOpen(false)}
      />
    </>,
    stage
  );
}
