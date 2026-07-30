import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { dtypes, schema } from "starintel_doc";
import {
  buildPredicateCatalog,
  recentPredicateIds,
  rememberPredicate,
  saveCustomPredicate,
  searchPredicates,
  similarPredicates,
  validateCustomPredicateId
} from "../../lib/predicate-catalog";
import { dtypeLabel } from "../../lib/schema-form";

function ConstraintSelect({ label, value, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <small>object type · optional</small>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="*">Any object type</option>
        {dtypes
          .filter((dtype) => dtype !== "relation")
          .map((dtype) => (
            <option key={dtype} value={dtype}>
              {dtypeLabel(dtype)}
            </option>
          ))}
      </select>
    </label>
  );
}

function CustomPredicateForm({ catalog, sourceType, targetType, onCreated, onClose }) {
  const [idInput, setIdInput] = useState("");
  const [label, setLabel] = useState("");
  const [sourceConstraint, setSourceConstraint] = useState(sourceType || "*");
  const [targetConstraint, setTargetConstraint] = useState(targetType || "*");
  const validation = validateCustomPredicateId(idInput);
  const similar = similarPredicates(validation.id, catalog);
  const duplicate = similar.find(
    (predicate) => predicate.id.replaceAll("-", "_") === validation.id
  );

  function submit(event) {
    event.preventDefault();
    try {
      const created = saveCustomPredicate(
        {
          id: idInput,
          label,
          sourceTypes: [sourceConstraint],
          targetTypes: [targetConstraint]
        },
        catalog
      );
      onCreated(created);
    } catch (error) {
      window.alert(error.message);
    }
  }

  return (
    <form className="custom-predicate-form" onSubmit={submit}>
      <header>
        <strong>Add predicate</strong>
        <button
          className="icon-button"
          type="button"
          aria-label="Close predicate form"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <label className="field">
        <span>Predicate ID</span>
        <small>lowercase snake_case</small>
        <input value={idInput} onChange={(event) => setIdInput(event.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>Label</span>
        <small>string · optional</small>
        <input value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <div className="graph-relation-grid">
        <ConstraintSelect
          label="Source type"
          value={sourceConstraint}
          onChange={setSourceConstraint}
        />
        <ConstraintSelect
          label="Target type"
          value={targetConstraint}
          onChange={setTargetConstraint}
        />
      </div>
      {!validation.valid && idInput && <p className="validation-error">{validation.message}</p>}
      {duplicate && (
        <p className="validation-error">A similar predicate already exists: {duplicate.id}</p>
      )}
      {!duplicate && similar.length > 0 && (
        <div className="predicate-similar-list">
          <small>Similar predicates</small>
          {similar.map((predicate) => (
            <code key={predicate.id}>{predicate.id}</code>
          ))}
        </div>
      )}
      <div className="form-actions">
        <button className="button primary" disabled={!validation.valid || Boolean(duplicate)}>
          Add predicate
        </button>
      </div>
    </form>
  );
}

export default function PredicateAutocomplete({
  value,
  onChange,
  documents,
  sourceType,
  targetType,
  error = ""
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const catalog = useMemo(
    () => buildPredicateCatalog({ activeSchema: schema, documents }),
    [catalogVersion, documents]
  );
  const results = useMemo(
    () =>
      searchPredicates(catalog, {
        query: value,
        documents,
        sourceType,
        targetType,
        recentIds: recentPredicateIds(),
        limit: 80
      }),
    [catalog, documents, sourceType, targetType, value]
  );

  function selectPredicate(predicate) {
    onChange(predicate.id);
    rememberPredicate(predicate.id);
    setOpen(false);
    setActiveIndex(0);
  }

  return (
    <div className="field predicate-autocomplete">
      <span>Predicate</span>
      <small>
        predicate · {sourceType || "any"} → {targetType || "any"}
      </small>
      <input
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-invalid={Boolean(error)}
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, Math.max(0, results.length - 1)));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          }
          if (event.key === "Enter" && open && results[activeIndex]) {
            event.preventDefault();
            selectPredicate(results[activeIndex]);
          }
          if (event.key === "Escape") setOpen(false);
        }}
        required
      />
      {error && <p className="validation-error">{error}</p>}
      {open && (
        <div className="predicate-popover">
          <div className="graph-picker-options" role="listbox">
            {results.map((predicate, index) => (
              <button
                key={predicate.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectPredicate(predicate)}
              >
                <strong>{predicate.id}</strong>
                <small>
                  {predicate.sourceTypes.join("|")} → {predicate.targetTypes.join("|")} ·{" "}
                  {predicate.source}
                </small>
                <span>{predicate.hint}</span>
              </button>
            ))}
            {!results.length && <span className="graph-picker-empty">No matching predicates</span>}
          </div>
          <button
            className="predicate-add-action"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setAdding(true)}
          >
            <Plus size={14} /> Add predicate
          </button>
          {adding && (
            <CustomPredicateForm
              catalog={catalog}
              sourceType={sourceType}
              targetType={targetType}
              onClose={() => setAdding(false)}
              onCreated={(created) => {
                setCatalogVersion((version) => version + 1);
                setAdding(false);
                selectPredicate(created);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
