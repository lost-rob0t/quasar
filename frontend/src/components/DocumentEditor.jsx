import { useEffect, useMemo, useState } from "react";
import { Braces, Plus, Save, Trash2, X } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  assertDocument,
  createDocument,
  dtypes,
  documentLabel,
  schema,
  touchDocument
} from "starintel_doc";
import { operation } from "../lib/operations";
import {
  dataFieldDescriptorsForDtype,
  dataFieldsForDtype,
  dataSchemaForDtype,
  dtypeLabel,
  effectiveFieldSchema,
  emptySchemaValue,
  essentialDataFieldsForDtype,
  fieldTypeHint,
  formatSchemaValue,
  generateEmptyDocument,
  humanizeSchemaField,
  parseSchemaField,
  schemaType
} from "../lib/schema-form";
import { useQuasar } from "../store";

const DRAFT_PREFIX = "quasar.editor-draft.v1:";

function parseJson(text, label, fallback) {
  if (!String(text || "").trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

function structuredValue(value, type) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value || (type === "array" ? "[]" : "{}"));
    if (type === "array" && Array.isArray(parsed)) return parsed;
    if (type === "object" && parsed && !Array.isArray(parsed) && typeof parsed === "object")
      return parsed;
  } catch {
    // Invalid legacy JSON is replaced by the first structured edit.
  }
  return type === "array" ? [] : {};
}

function inputType(fieldSchema = {}) {
  const resolved = effectiveFieldSchema(fieldSchema);
  if (resolved.format === "date") return "date";
  if (resolved.format === "date-time") return "datetime-local";
  if (resolved.format === "uri" || resolved.format === "url") return "url";
  if (resolved.type === "integer" || resolved.type === "number") return "number";
  return "text";
}

function isLongString(name, fieldSchema = {}) {
  const resolved = effectiveFieldSchema(fieldSchema);
  if (resolved.type !== "string") return false;
  return (
    /(description|summary|content|body|notes?|statement|definition|reason|text)$/i.test(name) ||
    /long text|markdown|multiline/i.test(
      `${resolved.description || ""} ${fieldSchema.description || ""}`
    )
  );
}

function ScalarValueInput({ name = "value", fieldSchema, value, onChange, referenceOptions = [] }) {
  const resolved = effectiveFieldSchema(fieldSchema);
  const enumValues = resolved.enum || fieldSchema.enum;
  const type = schemaType(fieldSchema);
  if (enumValues) {
    return (
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select…</option>
        {enumValues.map((item) => (
          <option key={String(item)} value={String(item)}>
            {String(item)}
          </option>
        ))}
      </select>
    );
  }
  if (resolved.type === "boolean") {
    return (
      <label className="checkbox schema-boolean-input">
        <input
          type="checkbox"
          checked={value === true || value === "true"}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{value === true || value === "true" ? "True" : "False"}</span>
      </label>
    );
  }
  if (isLongString(name, fieldSchema)) {
    return <textarea value={value ?? ""} onChange={(event) => onChange(event.target.value)} />;
  }
  const listId =
    referenceOptions.length && type.includes("reference")
      ? `reference-options-${String(name).replace(/[^a-zA-Z0-9_-]/g, "-")}`
      : undefined;
  return (
    <>
      <input
        type={inputType(fieldSchema)}
        step={resolved.type === "integer" ? "1" : resolved.type === "number" ? "any" : undefined}
        value={value ?? ""}
        list={listId}
        onChange={(event) => {
          if (resolved.type === "integer")
            onChange(event.target.value === "" ? "" : Number.parseInt(event.target.value, 10));
          else if (resolved.type === "number")
            onChange(event.target.value === "" ? "" : Number(event.target.value));
          else onChange(event.target.value);
        }}
      />
      {listId && (
        <datalist id={listId}>
          {referenceOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </datalist>
      )}
    </>
  );
}

function StructuredValueEditor({ fieldSchema, value, onChange, referenceOptions = [] }) {
  const resolved = effectiveFieldSchema(fieldSchema);
  if (resolved.type === "array") {
    const items = Array.isArray(value) ? value : [];
    const itemSchema = resolved.items || {};
    const itemType = effectiveFieldSchema(itemSchema).type;
    return (
      <div className="structured-list">
        {items.map((item, index) => (
          <div
            className={
              itemType === "object" || itemType === "array" || !itemType
                ? "structured-item nested"
                : "structured-item"
            }
            key={index}
          >
            {itemType === "object" || itemType === "array" || !itemType ? (
              <StructuredValueEditor
                fieldSchema={itemSchema}
                value={item}
                referenceOptions={referenceOptions}
                onChange={(next) =>
                  onChange(
                    items.map((current, itemIndex) => (itemIndex === index ? next : current))
                  )
                }
              />
            ) : (
              <ScalarValueInput
                name={`item-${index + 1}`}
                fieldSchema={itemSchema}
                value={item}
                referenceOptions={referenceOptions}
                onChange={(next) =>
                  onChange(
                    items.map((current, itemIndex) => (itemIndex === index ? next : current))
                  )
                }
              />
            )}
            <button
              className="icon-button danger structured-remove"
              type="button"
              aria-label={`Remove item ${index + 1}`}
              onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {!items.length && <small className="structured-empty">No values.</small>}
        <button
          className="button small structured-add"
          type="button"
          onClick={() => onChange([...items, emptySchemaValue(itemSchema)])}
        >
          <Plus size={14} /> Add value
        </button>
      </div>
    );
  }

  const objectValue = value && !Array.isArray(value) && typeof value === "object" ? value : {};
  const properties = resolved.properties || {};
  const propertyNames = Object.keys(properties);
  if (propertyNames.length) {
    const required = new Set(resolved.required || []);
    return (
      <div className="structured-object-fields">
        {propertyNames.map((name) => {
          const childSchema = properties[name] || {};
          const childType = effectiveFieldSchema(childSchema).type;
          return (
            <label className="structured-property" key={name}>
              <span>
                {humanizeSchemaField(name)}
                {required.has(name) ? " *" : ""}
              </span>
              <small>{fieldTypeHint(childSchema, required.has(name))}</small>
              {childType === "array" || childType === "object" || !childType ? (
                <StructuredValueEditor
                  fieldSchema={childSchema}
                  value={objectValue[name] ?? emptySchemaValue(childSchema)}
                  referenceOptions={referenceOptions}
                  onChange={(next) => onChange({ ...objectValue, [name]: next })}
                />
              ) : (
                <ScalarValueInput
                  name={name}
                  fieldSchema={childSchema}
                  value={objectValue[name] ?? ""}
                  referenceOptions={referenceOptions}
                  onChange={(next) => onChange({ ...objectValue, [name]: next })}
                />
              )}
            </label>
          );
        })}
      </div>
    );
  }

  const entries = Object.entries(objectValue);
  const valueSchema =
    typeof resolved.additionalProperties === "object" ? resolved.additionalProperties : {};
  return (
    <div className="structured-list">
      {entries.map(([key, entryValue], index) => (
        <div className="structured-item key-value" key={`${key}:${index}`}>
          <input
            aria-label={`Key ${index + 1}`}
            value={key}
            placeholder="Key"
            onChange={(event) => {
              const next = { ...objectValue };
              delete next[key];
              next[event.target.value] = entryValue;
              onChange(next);
            }}
          />
          <ScalarValueInput
            name={key || `property-${index + 1}`}
            fieldSchema={valueSchema}
            value={typeof entryValue === "object" ? JSON.stringify(entryValue) : entryValue}
            referenceOptions={referenceOptions}
            onChange={(nextValue) => onChange({ ...objectValue, [key]: nextValue })}
          />
          <button
            className="icon-button danger structured-remove"
            type="button"
            aria-label={`Remove ${key || "property"}`}
            onClick={() => {
              const next = { ...objectValue };
              delete next[key];
              onChange(next);
            }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {!entries.length && <small className="structured-empty">No properties.</small>}
      <button
        className="button small structured-add"
        type="button"
        onClick={() => {
          let index = entries.length + 1;
          let key = `property_${index}`;
          while (key in objectValue) key = `property_${++index}`;
          onChange({ ...objectValue, [key]: emptySchemaValue(valueSchema) });
        }}
      >
        <Plus size={14} /> Add property
      </button>
    </div>
  );
}

export function SchemaField({
  name,
  fieldSchema,
  required = false,
  value,
  onChange,
  referenceOptions = []
}) {
  const resolved = effectiveFieldSchema(fieldSchema);
  const labelId = `schema-field-${String(name).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const label = fieldSchema.title || resolved.title || humanizeSchemaField(name);
  const hint = fieldTypeHint(fieldSchema, required);

  if (resolved.type === "object" || resolved.type === "array" || !resolved.type) {
    return (
      <div className="field full dtype-data-field" role="group" aria-labelledby={labelId}>
        <span id={labelId}>
          {label}
          {required ? " *" : ""}
        </span>
        <small>{hint}</small>
        <StructuredValueEditor
          fieldSchema={fieldSchema}
          value={structuredValue(value, resolved.type === "array" ? "array" : "object")}
          referenceOptions={referenceOptions}
          onChange={(next) => onChange(JSON.stringify(next))}
        />
      </div>
    );
  }

  return (
    <label className={`field${isLongString(name, fieldSchema) ? " full" : ""}`}>
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      <small>{hint}</small>
      <ScalarValueInput
        name={name}
        fieldSchema={fieldSchema}
        value={value}
        onChange={onChange}
        referenceOptions={referenceOptions}
      />
    </label>
  );
}

function readDraft(token) {
  if (!token || typeof sessionStorage === "undefined") return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(`${DRAFT_PREFIX}${token}`) || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function plainDocument(dtype, form, data, base = {}) {
  return {
    ...base,
    _id: form.id || base._id || "",
    dataset: form.dataset,
    dtype,
    title: form.title,
    summary: form.summary,
    description: form.description,
    status: form.status,
    tags: form.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    sources: parseJson(form.sources, "Sources", []),
    evidence: parseJson(form.evidence, "Evidence", []),
    data
  };
}

export default function DocumentEditor({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { documents, execute, setNotice, workspace, addDocumentsToActiveGraph, runTargetActors } =
    useQuasar();
  const existing = mode === "edit" ? documents.find((document) => document._id === id) : null;
  const draftToken = params.get("draft");
  const initialDraft = useMemo(() => readDraft(draftToken), [draftToken]);
  const initialDocument = initialDraft || existing;
  const initialDtype = initialDocument?.dtype || params.get("dtype") || "entity";
  const [baseDocument, setBaseDocument] = useState(initialDocument || {});
  const [rawMode, setRawMode] = useState(false);
  const [advanced, setAdvanced] = useState(params.get("advanced") === "1");
  const [saving, setSaving] = useState(false);
  const [addedFields, setAddedFields] = useState([]);
  const [fieldPickerQuery, setFieldPickerQuery] = useState("");
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);
  const [dataValues, setDataValues] = useState({});
  const [rawValidation, setRawValidation] = useState("");
  const [form, setForm] = useState({
    id: initialDocument?._id || "",
    dataset: initialDocument?.dataset || params.get("dataset") || "default",
    dtype: initialDtype,
    title: initialDocument?.title || "",
    summary: initialDocument?.summary || "",
    description: initialDocument?.description || "",
    status: initialDocument?.status || "",
    tags: (initialDocument?.tags || []).join(", "),
    sources: JSON.stringify(initialDocument?.sources || [], null, 2),
    evidence: JSON.stringify(initialDocument?.evidence || [], null, 2),
    raw: JSON.stringify(initialDocument || {}, null, 2)
  });

  const currentDataSchema = useMemo(() => dataSchemaForDtype(form.dtype), [form.dtype]);
  const descriptors = useMemo(() => dataFieldDescriptorsForDtype(form.dtype), [form.dtype]);
  const descriptorByName = useMemo(
    () => new Map(descriptors.map((descriptor) => [descriptor.name, descriptor])),
    [descriptors]
  );
  const allFields = useMemo(() => dataFieldsForDtype(form.dtype), [form.dtype]);
  const essentialFields = useMemo(() => essentialDataFieldsForDtype(form.dtype), [form.dtype]);
  const essentialFieldSet = useMemo(() => new Set(essentialFields), [essentialFields]);
  const visibleAddedFields = useMemo(
    () => addedFields.filter((name) => allFields.includes(name) && !essentialFieldSet.has(name)),
    [addedFields, allFields, essentialFieldSet]
  );
  const visibleAddedFieldSet = useMemo(() => new Set(visibleAddedFields), [visibleAddedFields]);
  const availableFields = useMemo(
    () =>
      allFields.filter((name) => !essentialFieldSet.has(name) && !visibleAddedFieldSet.has(name)),
    [allFields, essentialFieldSet, visibleAddedFieldSet]
  );
  const matchingAvailableFields = useMemo(() => {
    const query = fieldPickerQuery.trim().toLowerCase();
    return availableFields
      .filter((name) => {
        if (!query) return true;
        const descriptor = descriptorByName.get(name);
        return `${name} ${descriptor?.label || ""} ${descriptor?.helpText || ""}`
          .toLowerCase()
          .includes(query);
      })
      .slice(0, 60);
  }, [availableFields, descriptorByName, fieldPickerQuery]);
  const renderedFields = useMemo(
    () => [...essentialFields, ...visibleAddedFields],
    [essentialFields, visibleAddedFields]
  );
  const requiredFields = useMemo(
    () => new Set(currentDataSchema.required || []),
    [currentDataSchema]
  );
  const objectType = dtypeLabel(form.dtype);
  const referenceOptions = useMemo(
    () =>
      documents.map((document) => ({
        value: document._id,
        label: `${documentLabel(document)} · ${document.dtype}`
      })),
    [documents]
  );

  useEffect(() => {
    const source = baseDocument?.dtype === form.dtype ? baseDocument.data || {} : {};
    const properties = dataSchemaForDtype(form.dtype).properties || {};
    const schemaFields = dataFieldsForDtype(form.dtype);
    const commonFields = new Set(essentialDataFieldsForDtype(form.dtype));
    setDataValues(
      Object.fromEntries(
        schemaFields.map((name) => [
          name,
          name in source ? formatSchemaValue(source[name], properties[name]) : ""
        ])
      )
    );
    setAddedFields(
      Object.keys(source).filter((name) => schemaFields.includes(name) && !commonFields.has(name))
    );
    setFieldPickerQuery("");
    setFieldPickerOpen(false);
  }, [baseDocument, form.dtype]);

  const update = (key) => (event) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));
  const updateData = (name, value) => setDataValues((current) => ({ ...current, [name]: value }));

  function addField(name) {
    if (!availableFields.includes(name)) return;
    setAddedFields((current) => [...current, name]);
    setFieldPickerQuery("");
    setFieldPickerOpen(false);
  }

  function removeField(name) {
    setAddedFields((current) => current.filter((field) => field !== name));
    setDataValues((current) => ({ ...current, [name]: "" }));
  }

  function buildTypedData() {
    const properties = currentDataSchema.properties || {};
    const data = { ...(baseDocument?.data || {}) };
    for (const name of allFields) {
      const parsed = parseSchemaField(name, dataValues[name], properties[name] || {}, parseJson);
      if (parsed === undefined) delete data[name];
      else data[name] = parsed;
    }
    return data;
  }

  function buildPlainDocument() {
    return plainDocument(form.dtype, form, buildTypedData(), baseDocument);
  }

  function hydrateFromDocument(document) {
    const dtype = document.dtype || form.dtype;
    setBaseDocument(document);
    setForm((current) => ({
      ...current,
      id: document._id || "",
      dataset: document.dataset || "default",
      dtype,
      title: document.title || "",
      summary: document.summary || "",
      description: document.description || "",
      status: document.status || "",
      tags: (document.tags || []).join(", "),
      sources: JSON.stringify(document.sources || [], null, 2),
      evidence: JSON.stringify(document.evidence || [], null, 2),
      raw: JSON.stringify(document, null, 2)
    }));
  }

  function toggleRawMode() {
    try {
      if (!rawMode) {
        const next = buildPlainDocument();
        setForm((current) => ({ ...current, raw: JSON.stringify(next, null, 2) }));
        setRawValidation("");
      } else {
        const parsed = parseJson(form.raw, "Document JSON", {});
        hydrateFromDocument(parsed);
      }
      setRawMode((value) => !value);
    } catch (error) {
      setRawValidation(error.message);
    }
  }

  function generateEmpty() {
    const current = String(form.raw || "").trim();
    if (
      current &&
      current !== "{}" &&
      !window.confirm("Replace current JSON?\n\nThis will discard the current editor contents.")
    )
      return;
    const generated = generateEmptyDocument(form.dtype);
    const raw = JSON.stringify(generated.document, null, 2);
    setForm((value) => ({ ...value, raw }));
    setRawMode(true);
    try {
      assertDocument(generated.document);
      setRawValidation("");
    } catch (error) {
      setRawValidation(error.message);
    }
    if (generated.warnings.length)
      setNotice({ kind: "warning", message: generated.warnings.join(" ") });
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    try {
      let document;
      if (rawMode) {
        document = assertDocument(parseJson(form.raw, "Document JSON", {}));
      } else {
        const changes = buildPlainDocument();
        document = existing
          ? touchDocument(existing, changes)
          : createDocument(form.dtype, { ...changes, _id: changes._id || undefined });
        document = assertDocument(document);
      }
      await execute(operation.save(document), `${existing ? "Update" : "Create"} ${document._id}`);
      if (draftToken) sessionStorage.removeItem(`${DRAFT_PREFIX}${draftToken}`);
      if (!existing && document.dtype === "target") await runTargetActors?.(document);
      if (params.get("returnTo") === "graph") {
        if (!existing) {
          const hasPosition = params.has("x") && params.has("y");
          const position = hasPosition
            ? { x: Number(params.get("x")), y: Number(params.get("y")) }
            : null;
          const changes = { selectedIds: [document._id] };
          if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
            changes.positions = { ...(workspace?.positions || {}), [document._id]: position };
          }
          addDocumentsToActiveGraph([document._id], changes);
        }
        navigate(`/graph?node=${encodeURIComponent(document._id)}`, {
          state: { revealUnreviewed: true, createdIds: existing ? [] : [document._id] }
        });
        return;
      }
      navigate(`/documents/${encodeURIComponent(document._id)}`);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
      setRawValidation(rawMode ? error.message : "");
    } finally {
      setSaving(false);
    }
  }

  if (mode === "edit" && !existing && !initialDraft) {
    return (
      <section className="empty-state">
        <h1>Document not found</h1>
        <code>{id}</code>
      </section>
    );
  }

  const renderFields = (names) =>
    names.map((name) => {
      const descriptor = descriptorByName.get(name);
      const removable = visibleAddedFieldSet.has(name);
      return (
        <div className="editor-schema-field" key={name}>
          <SchemaField
            name={name}
            fieldSchema={descriptor?.schema || currentDataSchema.properties?.[name] || {}}
            required={requiredFields.has(name)}
            value={dataValues[name] ?? ""}
            referenceOptions={referenceOptions}
            onChange={(value) => updateData(name, value)}
          />
          {removable && (
            <button
              className="icon-button danger editor-field-remove"
              type="button"
              aria-label={`Remove ${name}`}
              onClick={() => removeField(name)}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      );
    });

  return (
    <section className="simple-document-editor full-document-editor">
      <div className="page-heading simple-editor-heading">
        <div>
          <span className="eyebrow">{mode === "edit" ? "Edit" : "Create"}</span>
          <h1>
            {mode === "edit"
              ? `Edit ${documentLabel(existing || initialDraft)}`
              : `New ${objectType}`}
          </h1>
          <p>Full document editor.</p>
        </div>
        <div className="button-row">
          <button className="button small" type="button" onClick={toggleRawMode}>
            <Braces size={14} /> {rawMode ? "Basic" : "Inspect JSON"}
          </button>
          {rawMode && (
            <button className="button small" type="button" onClick={generateEmpty}>
              Generate empty document
            </button>
          )}
        </div>
      </div>

      <form className="editor-form simple-editor-form" onSubmit={submit}>
        {rawMode ? (
          <section className="simple-editor-section">
            <label className="field full">
              <span>Complete document JSON</span>
              <small>object · all schema keys available</small>
              <textarea
                className="code-editor tall"
                value={form.raw}
                onChange={(event) => {
                  setForm((current) => ({ ...current, raw: event.target.value }));
                  setRawValidation("");
                }}
              />
            </label>
            {rawValidation && <p className="validation-error">{rawValidation}</p>}
          </section>
        ) : (
          <>
            <section className="simple-editor-section">
              <div className="form-grid editor-basics-grid">
                {!existing && (
                  <label className="field">
                    <span>Object type</span>
                    <small>enum · required</small>
                    <select
                      value={form.dtype}
                      onChange={(event) => {
                        const next = event.target.value;
                        setBaseDocument((current) => ({
                          ...current,
                          dtype: next,
                          data: current.dtype === next ? current.data : {}
                        }));
                        setForm((current) => ({ ...current, dtype: next }));
                      }}
                    >
                      {dtypes.map((name) => (
                        <option key={name} value={name}>
                          {dtypeLabel(name)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="field">
                  <span>Dataset</span>
                  <small>string · required</small>
                  <input required value={form.dataset} onChange={update("dataset")} />
                </label>
              </div>
            </section>

            <section className="simple-editor-section object-fields-section">
              <div className="simple-editor-section-heading">
                <h2>Fields for {form.dtype}</h2>
                <span className={`dtype dtype-${form.dtype}`}>{form.dtype}</span>
              </div>
              <div className="form-grid dtype-field-grid">{renderFields(renderedFields)}</div>
              {!essentialFields.length && (
                <p className="muted">No essential fields are defined for this object type.</p>
              )}
              {availableFields.length > 0 && (
                <div
                  className="field-picker"
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget))
                      setFieldPickerOpen(false);
                  }}
                >
                  <button
                    className="button small"
                    type="button"
                    aria-expanded={fieldPickerOpen}
                    onClick={() => setFieldPickerOpen((value) => !value)}
                  >
                    <Plus size={14} /> Add field
                  </button>
                  {fieldPickerOpen && (
                    <div className="field-picker-options" id="schema-field-options" role="listbox">
                      <label className="field-picker-search">
                        <input
                          role="combobox"
                          aria-autocomplete="list"
                          aria-controls="schema-field-options"
                          aria-expanded={fieldPickerOpen}
                          value={fieldPickerQuery}
                          placeholder={`Search ${availableFields.length} fields`}
                          autoFocus
                          onChange={(event) => setFieldPickerQuery(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && matchingAvailableFields[0]) {
                              event.preventDefault();
                              addField(matchingAvailableFields[0]);
                            }
                            if (event.key === "Escape") setFieldPickerOpen(false);
                          }}
                        />
                      </label>
                      {matchingAvailableFields.map((name) => {
                        const descriptor = descriptorByName.get(name);
                        return (
                          <button
                            key={name}
                            type="button"
                            role="option"
                            aria-selected="false"
                            onClick={() => addField(name)}
                          >
                            <code>{name}</code>
                            <small>
                              {fieldTypeHint(descriptor?.schema || {}, descriptor?.required)}
                            </small>
                          </button>
                        );
                      })}
                      {!matchingAvailableFields.length && (
                        <span className="field-picker-empty">No matching fields</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            <button
              className="button small advanced-editor-toggle"
              type="button"
              aria-expanded={advanced}
              onClick={() => setAdvanced((value) => !value)}
            >
              {advanced ? "Basic" : "Advanced"}
            </button>

            {advanced && (
              <section className="simple-editor-section advanced-editor-section">
                <div className="simple-editor-section-heading">
                  <h2>Advanced</h2>
                </div>
                <h3>Document metadata</h3>
                <div className="form-grid details-field-grid">
                  <label className="field full">
                    <span>Title</span>
                    <small>string · optional</small>
                    <input value={form.title} onChange={update("title")} />
                  </label>
                  <label className="field">
                    <span>Document ID</span>
                    <small>string · optional until save</small>
                    <input value={form.id} onChange={update("id")} disabled={Boolean(existing)} />
                  </label>
                  <label className="field">
                    <span>Status</span>
                    <small>string · optional</small>
                    <input value={form.status} onChange={update("status")} />
                  </label>
                  <label className="field full">
                    <span>Summary</span>
                    <small>string · long text · optional</small>
                    <textarea value={form.summary} onChange={update("summary")} />
                  </label>
                  <label className="field full">
                    <span>Description</span>
                    <small>string · long text · optional</small>
                    <textarea value={form.description} onChange={update("description")} />
                  </label>
                  <label className="field full">
                    <span>Tags</span>
                    <small>string[] · comma separated</small>
                    <input value={form.tags} onChange={update("tags")} />
                  </label>
                </div>

                <h3>Sources and evidence</h3>
                <div className="form-grid dtype-field-grid details-field-grid">
                  <SchemaField
                    name="sources"
                    fieldSchema={
                      schema.properties?.sources || { type: "array", items: { type: "string" } }
                    }
                    value={form.sources}
                    referenceOptions={referenceOptions}
                    onChange={(value) => setForm((current) => ({ ...current, sources: value }))}
                  />
                  <SchemaField
                    name="evidence"
                    fieldSchema={
                      schema.properties?.evidence || { type: "array", items: { type: "string" } }
                    }
                    value={form.evidence}
                    referenceOptions={referenceOptions}
                    onChange={(value) => setForm((current) => ({ ...current, evidence: value }))}
                  />
                </div>
              </section>
            )}
          </>
        )}
        <div className="form-actions editor-save-bar">
          <button type="button" className="button" onClick={() => navigate(-1)}>
            Cancel
          </button>
          <button className="button primary" disabled={saving}>
            <Save size={16} /> {saving ? "Validating…" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}
