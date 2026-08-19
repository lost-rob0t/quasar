import { useEffect, useRef, useState } from "react";
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
  Trash2,
  X
} from "lucide-react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import GraphSelectMenu from "./GraphSelectMenu.jsx";

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

function toolbarButton(label) {
  return [...document.querySelectorAll(".graph-toolbar .button.small")].find(
    (candidate) => candidate.textContent.trim() === label
  );
}

function headingButton(label) {
  return [...document.querySelectorAll(".graph-heading-actions button")].find(
    (candidate) => candidate.textContent.trim() === label
  );
}

function labelsInput() {
  return [...document.querySelectorAll(".graph-toolbar .checkbox input")].find((input) =>
    input.closest("label")?.textContent.includes("Labels")
  );
}

function searchControl() {
  return document.querySelector(".graph-search input");
}

function setNativeInputValue(input, value) {
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
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
  const searchRef = useRef(null);
  const [mobile, setMobile] = useState(() => window.matchMedia?.(MOBILE_QUERY).matches ?? false);
  const [stage, setStage] = useState(null);
  const [open, setOpen] = useState(false);
  const [datasetOpen, setDatasetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusDisabled, setFocusDisabled] = useState(true);
  const [removeDisabled, setRemoveDisabled] = useState(true);
  const [deleteDisabled, setDeleteDisabled] = useState(true);
  const [labelsOn, setLabelsOn] = useState(true);

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const queryList = window.matchMedia(MOBILE_QUERY);
    const sync = () => setMobile(queryList.matches);
    sync();
    queryList.addEventListener?.("change", sync);
    return () => queryList.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    if (!graphRoute || !mobile) {
      setStage(null);
      setOpen(false);
      setDatasetOpen(false);
      setSearchOpen(false);
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
        setFocusDisabled(Boolean(toolbarButton("Focus")?.disabled));
        setRemoveDisabled(Boolean(headingButton("Remove from graph")?.disabled));
        setDeleteDisabled(Boolean(headingButton("Delete selected documents")?.disabled));
        const labels = labelsInput();
        if (labels) setLabelsOn(labels.checked);
        const search = searchControl();
        if (search) setQuery(search.value || "");
      });
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "checked", "value"]
    });
    document.addEventListener("input", sync);
    document.addEventListener("change", sync);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("input", sync);
      document.removeEventListener("change", sync);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [graphRoute, mobile]);

  useEffect(() => {
    if (!open && !datasetOpen && !searchOpen) return undefined;
    const close = (event) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setDatasetOpen(false);
      setSearchOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [datasetOpen, open, searchOpen]);

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
          onClick={() => headingButton("Add graph document")?.click()}
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
              onClick={() => {
                setOpen(false);
                setSearchOpen(true);
              }}
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
              onClick={() => run(() => toolbarButton("Fit")?.click())}
            />
            <ToolButton
              label="Focus"
              Icon={Focus}
              disabled={focusDisabled}
              onClick={() => run(() => toolbarButton("Focus")?.click())}
            />
            <ToolButton
              label="Labels"
              Icon={Tags}
              pressed={labelsOn}
              onClick={() => run(() => labelsInput()?.click())}
            />
            <ToolButton
              label="Clear"
              Icon={Eraser}
              onClick={() => run(() => headingButton("Clear graph")?.click())}
            />
            <ToolButton
              label="Remove"
              Icon={CircleMinus}
              disabled={removeDisabled}
              onClick={() => run(() => headingButton("Remove from graph")?.click())}
            />
            <ToolButton
              label="Delete"
              Icon={Trash2}
              disabled={deleteDisabled}
              onClick={() => run(() => headingButton("Delete selected documents")?.click())}
            />
          </div>
        </>
      )}

      {searchOpen && (
        <label className="graph-search-overlay">
          <Search size={18} aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            placeholder="Search graph"
            aria-label="Graph search overlay"
            onChange={(event) => {
              setQuery(event.target.value);
              setNativeInputValue(searchControl(), event.target.value);
            }}
          />
          <button
            type="button"
            aria-label="Close graph search"
            onClick={() => setSearchOpen(false)}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </label>
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
