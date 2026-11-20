import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

// Filter-as-you-type dataset picker for the documents search panel.
// Replaces the native <select> (the server catalog outgrew scrolling):
// type to narrow, arrow through, Enter to pick, Esc to dismiss.
// The filter logic is exported pure for unit tests.

export function filterDatasetOptions(options, query) {
  const text = String(query || "")
    .trim()
    .toLowerCase();
  if (!text) return options;
  return options.filter((option) => String(option).toLowerCase().includes(text));
}

export default function DatasetCombobox({ value, options, onChange, placeholder }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const listboxId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(-1);
    }
  }, [open]);

  const filtered = filterDatasetOptions(options, query);

  function commit(next) {
    onChange(next || "");
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, value ? -1 : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0 && filtered[activeIndex] !== undefined) {
        commit(filtered[activeIndex] === value ? "" : filtered[activeIndex]);
      } else if (query.trim()) {
        // Free-text datasets are valid: the workspace catalog may not know
        // every server dataset name yet.
        commit(query.trim());
      }
    }
  }

  const exactMatch = filtered.some(
    (option) => String(option).toLowerCase() === query.trim().toLowerCase()
  );
  const canCreate = open && query.trim() && !exactMatch;

  return (
    <label className="document-filter-control dataset-combobox" ref={rootRef}>
      <span>Dataset</span>
      <div
        className="dataset-combobox-field"
        data-open={open ? "true" : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <input
          type="text"
          role="combobox"
          aria-controls={open ? listboxId : undefined}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-label="Filter datasets"
          value={open ? query : value || ""}
          placeholder={placeholder || "All datasets"}
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {value && (
          <button
            type="button"
            className="dataset-combobox-clear"
            aria-label="Clear dataset filter"
            title="All datasets"
            onClick={() => commit("")}
          >
            ×
          </button>
        )}
      </div>
      {open && (
        <ul
          className="dataset-combobox-list"
          id={listboxId}
          role="listbox"
          aria-label="Datasets"
          ref={listRef}
        >
          {value && (
            <li>
              <button
                type="button"
                role="option"
                aria-selected={!value ? undefined : false}
                className="dataset-combobox-option dataset-combobox-all"
                onClick={() => commit("")}
              >
                All datasets
              </button>
            </li>
          )}
          {filtered.map((name) => (
            <li key={name}>
              <button
                type="button"
                role="option"
                aria-selected={name === value}
                className={`dataset-combobox-option${name === value ? " active" : ""}`}
                data-active={filtered[activeIndex] === name ? "true" : undefined}
                onClick={() => commit(name)}
              >
                {name}
              </button>
            </li>
          ))}
          {canCreate && (
            <li>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="dataset-combobox-option dataset-combobox-create"
                onClick={() => commit(query.trim())}
              >
                + Filter datasets by “{query.trim()}”
              </button>
            </li>
          )}
          {!filtered.length && !canCreate && (
            <li className="dataset-combobox-empty">No matching datasets.</li>
          )}
        </ul>
      )}
    </label>
  );
}
