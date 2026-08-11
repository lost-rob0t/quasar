import { Check, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

function findSelect(label) {
  return document.querySelector(`select[aria-label="${label}"]`);
}

export function readSelectOptions(select) {
  if (!select) return [];
  return [...select.options].map((option, index) => ({
    value: option.value,
    label: option.textContent?.trim() || option.value,
    disabled: option.disabled,
    selected: option.selected,
    index
  }));
}

function sameOptions(left, right) {
  return (
    left.length === right.length &&
    left.every((option, index) => {
      const candidate = right[index];
      return (
        option.value === candidate?.value &&
        option.label === candidate.label &&
        option.disabled === candidate.disabled &&
        option.selected === candidate.selected &&
        option.index === candidate.index
      );
    })
  );
}

export function setSelectValue(select, value) {
  if (!select) return false;
  const option = [...select.options].find((candidate) => candidate.value === value);
  if (!option || option.disabled) return false;

  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  if (setter) setter.call(select, value);
  else select.value = value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

export default function GraphSelectMenu({ open, selectLabel, title, listLabel, onClose }) {
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const closeRef = useRef(onClose);
  const [options, setOptions] = useState([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return undefined;
    }

    const sync = () => {
      const next = readSelectOptions(findSelect(selectLabel));
      setOptions((current) => (sameOptions(current, next) ? current : next));
    };
    sync();

    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "selected", "value"]
    });
    document.addEventListener("change", sync);
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      observer.disconnect();
      document.removeEventListener("change", sync);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, selectLabel]);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const visibleOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) =>
      `${option.label} ${option.value}`.toLowerCase().includes(normalized)
    );
  }, [options, query]);

  if (!open) return null;

  const optionButtons = () =>
    [...(listRef.current?.querySelectorAll('[role="option"]') || [])].filter(
      (button) => !button.disabled
    );

  const moveFocus = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = optionButtons();
    if (!buttons.length) return;
    event.preventDefault();
    const current = Math.max(0, buttons.indexOf(document.activeElement));
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const moveFromSearch = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = optionButtons();
    if (!buttons.length) return;
    event.preventDefault();
    const target = event.key === "ArrowUp" || event.key === "End" ? buttons.at(-1) : buttons[0];
    target?.focus();
  };

  return (
    <>
      <button
        type="button"
        className="graph-select-backdrop"
        aria-label={`Close ${title.toLowerCase()} picker`}
        onClick={() => closeRef.current()}
      />
      <section
        className="graph-select-picker"
        role="dialog"
        aria-modal="true"
        aria-label={`Select ${title.toLowerCase()}`}
      >
        <header className="graph-select-picker-header">
          <strong>{title}</strong>
          <button
            type="button"
            aria-label={`Close ${title.toLowerCase()} picker`}
            onClick={() => closeRef.current()}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <label className="graph-select-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            aria-label={`Search ${listLabel.toLowerCase()}`}
            placeholder={`Search ${listLabel.toLowerCase()}`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={moveFromSearch}
          />
          {query && (
            <button
              type="button"
              aria-label={`Clear ${listLabel.toLowerCase()} search`}
              onClick={() => setQuery("")}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </label>
        <div
          ref={listRef}
          className="graph-select-options"
          role="listbox"
          aria-label={listLabel}
          onKeyDown={moveFocus}
        >
          {visibleOptions.map((option) => (
            <button
              key={`${option.value}:${option.index}`}
              type="button"
              className="graph-select-option"
              role="option"
              aria-selected={option.selected}
              disabled={option.disabled}
              onClick={() => {
                if (setSelectValue(findSelect(selectLabel), option.value)) closeRef.current();
              }}
            >
              <span>{option.label}</span>
              {option.selected && <Check size={17} aria-hidden="true" />}
            </button>
          ))}
          {!options.length && <p className="muted">No options.</p>}
          {Boolean(options.length) && !visibleOptions.length && (
            <p className="muted">No matching {listLabel.toLowerCase()}.</p>
          )}
        </div>
      </section>
    </>
  );
}
