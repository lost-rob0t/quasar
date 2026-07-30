import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { dtypes } from "starintel_doc";
import { dtypeLabel } from "../lib/schema-form";
import { CompactNodeEditor, CompactResearchNodeEditor, GraphModalShell } from "./GraphEditors";

export function knownGraphObjectTypes() {
  return [...new Set(dtypes)]
    .filter((objectType) => objectType && objectType !== "relation")
    .map((objectType) => ({ objectType, label: dtypeLabel(objectType) }))
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.objectType.localeCompare(right.objectType)
    );
}

function graphContextPosition(menu) {
  const stage = menu?.closest(".graph-stage");
  if (!stage) return null;
  const left = Number.parseFloat(menu.style.left || "0");
  const top = Number.parseFloat(menu.style.top || "0");
  return {
    rendered: {
      x: Number.isFinite(left) ? left : 0,
      y: Number.isFinite(top) ? top : 0
    },
    bounds: {
      width: stage.clientWidth || window.innerWidth,
      height: stage.clientHeight || window.innerHeight
    }
  };
}

function activeDataset() {
  return document.querySelector('select[aria-label="Dataset filter"]')?.value?.trim() || "default";
}

export default function GraphObjectTypePickerBridge() {
  const [picker, setPicker] = useState(null);
  const [draft, setDraft] = useState(null);
  const [query, setQuery] = useState("");
  const objectTypes = useMemo(() => knownGraphObjectTypes(), []);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return objectTypes.filter(
      ({ objectType, label }) => !needle || `${objectType} ${label}`.toLowerCase().includes(needle)
    );
  }, [objectTypes, query]);

  useEffect(() => {
    const intercept = (event) => {
      const action = event.target.closest?.("button[role='menuitem']");
      if (action?.textContent?.replace(/\s+/g, " ").trim() !== "Other object type") return;
      const menu = action.closest(".graph-context-menu");
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setQuery("");
      setPicker({
        dataset: activeDataset(),
        position: graphContextPosition(menu)
      });
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    };
    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, []);

  function selectObjectType(objectType) {
    setDraft({
      objectType,
      dataset: picker?.dataset || "default",
      position: picker?.position || null
    });
    setPicker(null);
    setQuery("");
  }

  return (
    <>
      {picker && (
        <GraphModalShell
          title="Select object type"
          position={picker.position}
          onClose={() => setPicker(null)}
          className="graph-object-type-picker"
        >
          <div className="graph-compact-form">
            <label className="graph-picker-search">
              <Search size={14} aria-hidden="true" />
              <input
                role="combobox"
                aria-label="Search object types"
                aria-autocomplete="list"
                aria-controls="graph-object-type-options"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search object types"
                autoFocus
              />
            </label>
            <div
              id="graph-object-type-options"
              className="graph-picker-options"
              role="listbox"
              aria-label="Object types"
            >
              {matches.map(({ objectType, label }) => (
                <button
                  key={objectType}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => selectObjectType(objectType)}
                >
                  <strong>{label}</strong>
                  <code>{objectType}</code>
                </button>
              ))}
              {!matches.length && (
                <span className="graph-picker-empty">No matching object types</span>
              )}
            </div>
            <div className="form-actions graph-editor-actions">
              <span />
              <span />
              <button className="button" type="button" onClick={() => setPicker(null)}>
                Cancel
              </button>
            </div>
          </div>
        </GraphModalShell>
      )}
      {draft && draft.objectType !== "research-node" && (
        <CompactNodeEditor
          objectType={draft.objectType}
          dataset={draft.dataset}
          position={draft.position}
          onClose={() => setDraft(null)}
        />
      )}
      {draft?.objectType === "research-node" && (
        <CompactResearchNodeEditor
          dataset={draft.dataset}
          position={draft.position}
          onClose={() => setDraft(null)}
        />
      )}
    </>
  );
}
