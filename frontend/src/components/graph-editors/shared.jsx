import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { documentLabel } from "starintel_doc";
import { fieldTypeHint } from "../../lib/schema-form";

export const DRAFT_PREFIX = "quasar.editor-draft.v1:";
export const DRAFT_META_PREFIX = "quasar.editor-draft-meta.v1:";

export function parseJson(text, label, fallback) {
  if (!String(text || "").trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

function draftToken() {
  return (
    globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function saveEditorDraft(document, metadata = {}) {
  const token = draftToken();
  const serialized = JSON.stringify(document);
  sessionStorage.setItem(`${DRAFT_PREFIX}${token}`, serialized);
  localStorage.setItem(`${DRAFT_PREFIX}${token}`, serialized);
  localStorage.setItem(`${DRAFT_META_PREFIX}${token}`, JSON.stringify(metadata));
  return token;
}

function focusableElements(root) {
  return [
    ...root.querySelectorAll(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
    )
  ];
}

export function GraphModalShell({
  title,
  position,
  onClose,
  dirty = false,
  children,
  className = ""
}) {
  const modalRef = useRef(null);
  const returnFocusRef = useRef(null);

  function requestClose() {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  }

  useEffect(() => {
    document.body.classList.add("graph-editor-open");
    return () => document.body.classList.remove("graph-editor-open");
  }, []);

  useEffect(() => {
    const root = modalRef.current;
    if (!root) return undefined;
    returnFocusRef.current = document.activeElement;
    focusableElements(root)[0]?.focus();
    const keydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableElements(root);
      if (!elements.length) return;
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", keydown);
    return () => {
      root.removeEventListener("keydown", keydown);
      returnFocusRef.current?.focus?.();
    };
  }, [dirty, onClose]);

  const style =
    position?.rendered && position?.bounds
      ? {
          "--graph-editor-left": `${Math.max(8, Math.min(position.rendered.x, position.bounds.width - 470))}px`,
          "--graph-editor-top": `${Math.max(8, Math.min(position.rendered.y, position.bounds.height - 560))}px`
        }
      : undefined;

  return (
    <div
      className="graph-editor-layer"
      onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      <section
        ref={modalRef}
        className={`graph-compact-editor ${className}`}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" type="button" aria-label="Close" onClick={requestClose}>
            <X size={17} />
          </button>
        </header>
        {typeof children === "function" ? children(requestClose) : children}
      </section>
    </div>
  );
}

export function DocumentSelect({
  label,
  value,
  documents,
  objectTypes = [],
  required = false,
  error = "",
  onChange
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = documents.find((document) => document._id === value);
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return documents
      .filter((document) => document.dtype !== "relation")
      .filter((document) => !objectTypes.length || objectTypes.includes(document.dtype))
      .filter(
        (document) =>
          !needle ||
          `${document._id} ${documentLabel(document)} ${document.dtype}`
            .toLowerCase()
            .includes(needle)
      )
      .slice(0, 80);
  }, [documents, objectTypes, query]);

  return (
    <div className="field graph-document-select">
      <span>{label}</span>
      <small>
        document reference{objectTypes.length ? ` · ${objectTypes.join(" or ")}` : ""}
        {required ? " · required" : " · optional"}
      </small>
      <button
        type="button"
        className="graph-select-trigger"
        aria-expanded={open}
        aria-invalid={Boolean(error)}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected ? documentLabel(selected) : "Select document"}</span>
        <code>{selected?._id || ""}</code>
      </button>
      {error && <p className="validation-error">{error}</p>}
      {open && (
        <div className="graph-select-popover">
          <label className="graph-picker-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search documents"
              autoFocus
            />
          </label>
          <div className="graph-picker-options" role="listbox">
            {matching.map((document) => (
              <button
                key={document._id}
                type="button"
                role="option"
                aria-selected={document._id === value}
                onClick={() => {
                  onChange(document._id);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <strong>{documentLabel(document)}</strong>
                <small>
                  {document.dtype} · {document._id}
                </small>
              </button>
            ))}
            {!matching.length && <span className="graph-picker-empty">No matching documents</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function FieldPicker({ descriptors, added, onAdd }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const available = useMemo(
    () => descriptors.filter((descriptor) => !added.includes(descriptor.name)),
    [added, descriptors]
  );
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return available
      .filter(
        (descriptor) =>
          !needle ||
          `${descriptor.name} ${descriptor.label} ${descriptor.helpText}`
            .toLowerCase()
            .includes(needle)
      )
      .slice(0, 60);
  }, [available, query]);
  if (!available.length) return null;
  return (
    <div className="graph-field-picker">
      <button
        className="button small"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={14} /> Add field
      </button>
      {open && (
        <div className="graph-picker-popover">
          <label className="graph-picker-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search fields"
              autoFocus
            />
          </label>
          <div className="graph-picker-options" role="listbox">
            {matching.map((descriptor) => (
              <button
                key={descriptor.name}
                type="button"
                onClick={() => {
                  onAdd(descriptor.name);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <code>{descriptor.name}</code>
                <small>{fieldTypeHint(descriptor.schema, descriptor.required)}</small>
              </button>
            ))}
            {!matching.length && <span className="graph-picker-empty">No matching fields</span>}
          </div>
        </div>
      )}
    </div>
  );
}
