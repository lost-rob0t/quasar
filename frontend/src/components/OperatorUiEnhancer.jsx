import { useEffect, useRef, useState } from "react";
import {
  Database,
  Focus,
  LayoutGrid,
  Maximize2,
  Menu,
  Network,
  Plus,
  Search,
  Tags,
  Trash2,
  X
} from "lucide-react";
import { createPortal } from "react-dom";
import GraphSelectMenu from "./GraphSelectMenu.jsx";
import { useLocation } from "react-router-dom";

function isAgentDisclosure(entry) {
  return entry?.matches?.(
    ".agent-log-entry.tool, .agent-log-entry.model, .agent-log-entry.thinking, .agent-log-entry.reasoning"
  );
}

function disclosureLabel(entry) {
  const heading = entry.querySelector(":scope > strong")?.textContent?.trim();
  return entry.classList.contains("tool") ? heading || "Tool run" : "Agent thinking";
}

function prepareAgentEntry(entry) {
  if (!isAgentDisclosure(entry)) return;
  if (!entry.dataset.expanded) entry.dataset.expanded = "false";
  entry.classList.add("agent-log-collapsible");
  entry.dataset.disclosureReady = "true";
  entry.tabIndex = 0;
  entry.setAttribute("role", "button");
  entry.setAttribute("aria-expanded", entry.dataset.expanded);
  entry.setAttribute(
    "aria-label",
    `${entry.dataset.expanded === "true" ? "Collapse" : "Expand"} ${disclosureLabel(entry)}`
  );
}

function prepareAgentEntries() {
  document
    .querySelectorAll(
      ".agent-log-entry.tool, .agent-log-entry.model, .agent-log-entry.thinking, .agent-log-entry.reasoning"
    )
    .forEach(prepareAgentEntry);
}

function toggleAgentEntry(entry) {
  const expanded = entry.dataset.expanded !== "true";
  entry.dataset.expanded = String(expanded);
  entry.setAttribute("aria-expanded", String(expanded));
  entry.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${disclosureLabel(entry)}`);
}

function prepareGraphControls() {
  document.querySelectorAll(".graph-toolbar .button.small").forEach((button) => {
    const label = button.textContent.trim();
    if (label === "Fit" || label === "Focus") button.setAttribute("aria-label", label);
  });
}

function prepareRadialMenus() {
  document.querySelectorAll(".graph-context-menu").forEach((menu) => {
    const isBlankCanvasRoot =
      menu.classList.contains("canvas-actions") &&
      Boolean(menu.querySelector(".graph-context-palette"));
    menu.classList.toggle("radial-root", isBlankCanvasRoot);
    if (!isBlankCanvasRoot || menu.dataset.radialPositioned === "true") return;

    const stage = menu.closest(".graph-stage");
    const width = 228;
    const height = 228;
    const stageWidth = stage?.clientWidth || width + 16;
    const stageHeight = stage?.clientHeight || height + 16;
    const sourceLeft = Number.parseFloat(menu.style.left || "0");
    const sourceTop = Number.parseFloat(menu.style.top || "0");
    menu.style.left = `${Math.max(8, Math.min(sourceLeft - width / 2, stageWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(sourceTop - height / 2, stageHeight - height - 8))}px`;
    menu.dataset.radialPositioned = "true";
  });
}

function updateGraphEmptyCopy() {
  document.querySelectorAll(".graph-empty-state p").forEach((node) => {
    if (node.textContent.includes("Right-click anywhere")) {
      node.textContent = node.textContent.replace(
        "Right-click anywhere",
        "Hold or right-click the blank canvas"
      );
    }
  });
}

function updatePersistentSecretCopy() {
  document.querySelectorAll(".agent-editor .field > span").forEach((node) => {
    if (node.textContent.includes("set for this session")) {
      node.textContent = node.textContent.replace("set for this session", "saved on this device");
    }
  });
  document
    .querySelectorAll(".agent-editor .muted, .agent-editor .button-row + *")
    .forEach((node) => {
      if (node.textContent.includes("Keys stay in this browser session")) {
        node.textContent = node.textContent.replace(
          "Keys stay in this browser session",
          "Keys stay in this browser on this device"
        );
      }
      if (node.textContent.includes("Brave key set for this session")) {
        node.textContent = node.textContent.replace(
          "Brave key set for this session",
          "Brave key saved on this device"
        );
      }
    });
}

function prepareUi() {
  prepareAgentEntries();
  prepareGraphControls();
  prepareRadialMenus();
  updateGraphEmptyCopy();
  updatePersistentSecretCopy();
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

function selectControl(label) {
  return document.querySelector(`select[aria-label="${label}"]`);
}

function layoutControl() {
  return selectControl("Maltego graph layout") || selectControl("Graph layout");
}

function searchControl() {
  return document.querySelector(".graph-search input");
}

function navigationButton() {
  return document.querySelector('button[aria-label="Open menu"]');
}

function labelsInput() {
  return [...document.querySelectorAll(".graph-toolbar .checkbox input")].find((input) =>
    input.closest("label")?.textContent.includes("Labels")
  );
}

function optionLabel(select) {
  return select?.selectedOptions?.[0]?.textContent?.trim() || "";
}

function shortLabel(value, fallback) {
  const text = String(value || fallback || "")
    .replace(/\s*[·—].*$/, "")
    .trim();
  return text.length > 9 ? `${text.slice(0, 8)}…` : text;
}

function setNativeInputValue(input, value) {
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function cycleControl(select, direction = 1) {
  if (!select?.options?.length) return;
  const count = select.options.length;
  select.selectedIndex = (select.selectedIndex + direction + count) % count;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

export default function OperatorUiEnhancer() {
  const location = useLocation();
  const graphRoute = location.pathname === "/graph";
  const searchRef = useRef(null);
  const [graphStage, setGraphStage] = useState(null);
  const [labelsOn, setLabelsOn] = useState(true);
  const [focusDisabled, setFocusDisabled] = useState(true);
  const [removeDisabled, setRemoveDisabled] = useState(true);
  const [deleteDisabled, setDeleteDisabled] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [datasetLabel, setDatasetLabel] = useState("All datasets");
  const [datasetOpen, setDatasetOpen] = useState(false);
  const [layoutLabel, setLayoutLabel] = useState("Organic");
  const [graphLabel, setGraphLabel] = useState("All documents");
  const [countText, setCountText] = useState("");

  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    const sync = () => {
      prepareUi();
      const nextStage = graphRoute ? document.querySelector(".graph-stage") : null;
      setGraphStage((current) => (current === nextStage ? current : nextStage));
      setFocusDisabled(Boolean(toolbarButton("Focus")?.disabled));
      setRemoveDisabled(Boolean(headingButton("Remove from graph")?.disabled));
      setDeleteDisabled(Boolean(headingButton("Delete selected documents")?.disabled));
      const labels = labelsInput();
      if (labels) setLabelsOn(labels.checked);
      const search = searchControl();
      if (search) setQuery(search.value || "");
      setDatasetLabel(optionLabel(selectControl("Dataset filter")) || "All datasets");
      setLayoutLabel(optionLabel(layoutControl()) || "Organic");
      setGraphLabel(optionLabel(selectControl("Active graph")) || "All documents");
      setCountText(document.querySelector(".graph-count")?.textContent?.trim() || "");
    };

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["disabled"]
    });
    document.addEventListener("change", schedule);
    document.addEventListener("input", schedule);
    schedule();
    return () => {
      observer.disconnect();
      document.removeEventListener("change", schedule);
      document.removeEventListener("input", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [graphRoute, location.pathname]);

  useEffect(() => {
    const onClick = (event) => {
      const entry = event.target.closest?.(".agent-log-entry");
      if (!isAgentDisclosure(entry) || event.target.closest("pre")) return;
      toggleAgentEntry(entry);
    };
    const onKeyDown = (event) => {
      const entry = event.target.closest?.(".agent-log-entry");
      if (isAgentDisclosure(entry) && ["Enter", " "].includes(event.key)) {
        event.preventDefault();
        toggleAgentEntry(entry);
        return;
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setDatasetOpen(false);
      }
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  if (!graphRoute || !graphStage) return null;
  return createPortal(
    <>
      <div className="graph-mode-actions" aria-label="Graph view controls">
        <button
          type="button"
          className="graph-canvas-action"
          aria-label="Open menu"
          title="Open navigation"
          onClick={() => navigationButton()?.click()}
        >
          <Menu size={18} aria-hidden="true" />
          <span>Menu</span>
        </button>
        <button
          type="button"
          className="graph-canvas-action"
          aria-label="Search graph"
          title="Search graph"
          aria-pressed={searchOpen}
          onClick={() => {
            setDatasetOpen(false);
            setSearchOpen((value) => !value);
          }}
        >
          <Search size={18} aria-hidden="true" />
          <span>Search</span>
        </button>
        <button
          type="button"
          className="graph-canvas-action"
          aria-label="Cycle active graph"
          title={`Graph: ${graphLabel}. Tap for next; right-click for previous.`}
          onClick={() => cycleControl(selectControl("Active graph"), 1)}
          onContextMenu={(event) => {
            event.preventDefault();
            cycleControl(selectControl("Active graph"), -1);
          }}
        >
          <Network size={18} aria-hidden="true" />
          <span>{shortLabel(graphLabel, "Graph")}</span>
        </button>
        <button
          type="button"
          className="graph-canvas-action"
          aria-label="Select dataset"
          title={`Dataset: ${datasetLabel}. Choose dataset.`}
          aria-haspopup="listbox"
          aria-expanded={datasetOpen}
          onClick={() => {
            setSearchOpen(false);
            setDatasetOpen((value) => !value);
          }}
        >
          <Database size={18} aria-hidden="true" />
          <span>{shortLabel(datasetLabel, "Dataset")}</span>
        </button>
        <button
          type="button"
          className="graph-canvas-action"
          aria-label="Cycle layout"
          title={`Layout: ${layoutLabel}. Tap for next; right-click for previous.`}
          onClick={() => cycleControl(layoutControl(), 1)}
          onContextMenu={(event) => {
            event.preventDefault();
            cycleControl(layoutControl(), -1);
          }}
        >
          <LayoutGrid size={18} aria-hidden="true" />
          <span>{shortLabel(layoutLabel, "Layout")}</span>
        </button>
      </div>

      <GraphSelectMenu
        open={datasetOpen}
        selectLabel="Dataset filter"
        title="Dataset"
        listLabel="Datasets"
        onClose={() => setDatasetOpen(false)}
      />

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

      <div className="graph-canvas-actions" aria-label="Graph actions">
        <button
          type="button"
          className="graph-canvas-action"
          aria-label="Add graph document"
          title="Add graph document"
          onClick={() => headingButton("Add graph document")?.click()}
        >
          <Plus size={18} aria-hidden="true" />
          <span>Add</span>
        </button>
        <button
          type="button"
          className="graph-canvas-action"
          aria-label="Fit graph"
          title="Fit graph"
          onClick={() => toolbarButton("Fit")?.click()}
        >
          <Maximize2 size={18} aria-hidden="true" />
          <span>Fit</span>
        </button>
        <button
          type="button"
          className="graph-canvas-action"
          aria-label="Focus selection"
          title="Focus selection"
          disabled={focusDisabled}
          onClick={() => toolbarButton("Focus")?.click()}
        >
          <Focus size={18} aria-hidden="true" />
          <span>Focus</span>
        </button>
        <button
          type="button"
          className="graph-canvas-action"
          aria-label="Toggle labels"
          title="Toggle labels"
          aria-pressed={labelsOn}
          onClick={() => labelsInput()?.click()}
        >
          <Tags size={18} aria-hidden="true" />
          <span>Labels</span>
        </button>
        <button
          type="button"
          className="graph-canvas-action"
          aria-label="Clear graph"
          title="Clear graph"
          onClick={() => headingButton("Clear graph")?.click()}
        >
          <X size={18} aria-hidden="true" />
          <span>Clear</span>
        </button>
        <button
          type="button"
          className="graph-canvas-action danger"
          aria-label="Remove from graph"
          title="Remove from graph"
          disabled={removeDisabled}
          onClick={() => headingButton("Remove from graph")?.click()}
        >
          <Trash2 size={18} aria-hidden="true" />
          <span>Remove</span>
        </button>
        <button
          type="button"
          className="graph-canvas-action danger"
          aria-label="Delete selected documents"
          title="Delete selected documents"
          disabled={deleteDisabled}
          onClick={() => headingButton("Delete selected documents")?.click()}
        >
          <Trash2 size={18} aria-hidden="true" />
          <span>Delete</span>
        </button>
      </div>

      {countText && <div className="graph-count-overlay">{countText}</div>}
    </>,
    graphStage
  );
}
