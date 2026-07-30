import { useMemo, useState } from "react";
import { ArrowLeftRight, Braces, Save, Trash2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  assertDocument,
  createRelation,
  documentLabel,
  schema,
  touchDocument
} from "starintel_doc";
import { operation } from "../../lib/operations";
import { buildPredicateCatalog, rememberPredicate } from "../../lib/predicate-catalog";
import {
  dataFieldDescriptorsForDtype,
  fieldTypeHint,
  formatSchemaValue,
  generateEmptyDocument,
  parseSchemaField
} from "../../lib/schema-form";
import { useQuasar } from "../../store";
import { SchemaField } from "../DocumentEditor";
import PredicateAutocomplete from "./PredicateAutocomplete";
import { DocumentSelect, FieldPicker, GraphModalShell, parseJson, saveEditorDraft } from "./shared";

const SOURCE_FIELDS = ["subject", "source"];
const TARGET_FIELDS = ["object", "target"];
const START_FIELDS = ["start_at", "start_date", "valid_from", "started_at"];
const END_FIELDS = ["end_at", "end_date", "valid_to", "ended_at"];
const DESCRIPTION_FIELDS = ["description", "note"];

function firstField(descriptors, candidates) {
  return (
    candidates.find((name) => descriptors.some((descriptor) => descriptor.name === name)) ||
    candidates[0]
  );
}

function relationEndpointIds(relation) {
  return [
    SOURCE_FIELDS.map((name) => relation?.data?.[name]).find(Boolean) || "",
    TARGET_FIELDS.map((name) => relation?.data?.[name]).find(Boolean) || ""
  ];
}

function emptyRequired(value) {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

function compatible(types, selected) {
  return !selected || !types?.length || types.includes("*") || types.includes(selected);
}

export default function CompactRelationEditor({
  ids = [],
  documents = [],
  relationDocument = null,
  position = null,
  onClose,
  onSaved
}) {
  const navigate = useNavigate();
  const { execute, setNotice, addDocumentsToActiveGraph } = useQuasar();
  const descriptors = useMemo(() => dataFieldDescriptorsForDtype("relation"), []);
  const descriptorByName = useMemo(
    () => new Map(descriptors.map((descriptor) => [descriptor.name, descriptor])),
    [descriptors]
  );
  const sourceField = firstField(descriptors, SOURCE_FIELDS);
  const targetField = firstField(descriptors, TARGET_FIELDS);
  const startField = START_FIELDS.find((name) => descriptorByName.has(name));
  const endField = END_FIELDS.find((name) => descriptorByName.has(name));
  const descriptionField = DESCRIPTION_FIELDS.find((name) => descriptorByName.has(name));
  const coreFields = useMemo(
    () =>
      new Set(
        [
          sourceField,
          targetField,
          "predicate",
          "directed",
          startField,
          endField,
          descriptionField
        ].filter(Boolean)
      ),
    [descriptionField, endField, sourceField, startField, targetField]
  );
  const optionalDescriptors = useMemo(
    () => descriptors.filter((descriptor) => !coreFields.has(descriptor.name)),
    [coreFields, descriptors]
  );
  const existingIds = relationEndpointIds(relationDocument);
  const initialSourceId = ids[0] || existingIds[0] || "";
  const initialTargetId = ids[1] || existingIds[1] || "";
  const [sourceId, setSourceId] = useState(initialSourceId);
  const [targetId, setTargetId] = useState(initialTargetId);
  const source = documents.find((document) => document._id === sourceId);
  const target = documents.find((document) => document._id === targetId);
  const [predicate, setPredicate] = useState(relationDocument?.data?.predicate || "related-to");
  const [dataset, setDataset] = useState(
    relationDocument?.dataset || source?.dataset || target?.dataset || "default"
  );
  const [directed, setDirected] = useState(relationDocument?.data?.directed ?? true);
  const [description, setDescription] = useState(
    relationDocument?.description ||
      (descriptionField ? relationDocument?.data?.[descriptionField] : "") ||
      ""
  );
  const [sources, setSources] = useState(JSON.stringify(relationDocument?.sources || [], null, 2));
  const [startValue, setStartValue] = useState(
    startField
      ? formatSchemaValue(
          relationDocument?.data?.[startField],
          descriptorByName.get(startField)?.schema || {}
        )
      : ""
  );
  const [endValue, setEndValue] = useState(
    endField
      ? formatSchemaValue(
          relationDocument?.data?.[endField],
          descriptorByName.get(endField)?.schema || {}
        )
      : ""
  );
  const [added, setAdded] = useState(() =>
    optionalDescriptors
      .filter((descriptor) => descriptor.name in (relationDocument?.data || {}))
      .map((descriptor) => descriptor.name)
  );
  const [values, setValues] = useState(() =>
    Object.fromEntries(
      optionalDescriptors.map((descriptor) => [
        descriptor.name,
        formatSchemaValue(relationDocument?.data?.[descriptor.name], descriptor.schema)
      ])
    )
  );
  const [rawMode, setRawMode] = useState(false);
  const [raw, setRaw] = useState(() =>
    JSON.stringify(
      relationDocument || {
        dataset: relationDocument?.dataset || source?.dataset || target?.dataset || "default",
        dtype: "relation",
        description: "",
        sources: [],
        data: {
          [sourceField]: initialSourceId,
          predicate: "related-to",
          [targetField]: initialTargetId,
          directed: true
        }
      },
      null,
      2
    )
  );
  const [rawValidation, setRawValidation] = useState("");
  const [errors, setErrors] = useState({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const sourceLocked = Boolean(ids[0]);
  const targetLocked = Boolean(ids[1]);
  const catalog = useMemo(
    () => buildPredicateCatalog({ activeSchema: schema, documents }),
    [documents]
  );

  function setOptionalValue(name, value) {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: "" }));
    setDirty(true);
  }

  function addField(name) {
    setAdded((current) => [...new Set([...current, name])]);
    setDirty(true);
  }

  function removeField(name) {
    setAdded((current) => current.filter((field) => field !== name));
    setValues((current) => ({ ...current, [name]: "" }));
    setDirty(true);
  }

  function relationData() {
    const data = { ...(relationDocument?.data || {}) };
    for (const name of SOURCE_FIELDS) delete data[name];
    for (const name of TARGET_FIELDS) delete data[name];
    data[sourceField] = sourceId;
    data.predicate = predicate;
    data[targetField] = targetId;
    data.directed = directed;
    if (startField) {
      const parsed = parseSchemaField(
        startField,
        startValue,
        descriptorByName.get(startField)?.schema || {},
        parseJson
      );
      if (parsed === undefined) delete data[startField];
      else data[startField] = parsed;
    }
    if (endField) {
      const parsed = parseSchemaField(
        endField,
        endValue,
        descriptorByName.get(endField)?.schema || {},
        parseJson
      );
      if (parsed === undefined) delete data[endField];
      else data[endField] = parsed;
    }
    if (descriptionField) {
      if (description) data[descriptionField] = description;
      else delete data[descriptionField];
    }
    for (const descriptor of optionalDescriptors) {
      if (!added.includes(descriptor.name)) {
        delete data[descriptor.name];
        continue;
      }
      const parsed = parseSchemaField(
        descriptor.name,
        values[descriptor.name],
        descriptor.schema,
        parseJson
      );
      if (parsed === undefined) delete data[descriptor.name];
      else data[descriptor.name] = parsed;
    }
    return data;
  }

  function buildDraft() {
    if (rawMode) return parseJson(raw, "Relation JSON", {});
    return {
      ...(relationDocument || {}),
      dataset,
      dtype: "relation",
      title: `${documentLabel(source) || sourceId} ${predicate} ${documentLabel(target) || targetId}`,
      description,
      sources: parseJson(sources, "Sources", []),
      data: relationData()
    };
  }

  function validateBasic(draft) {
    const nextErrors = {};
    const data = draft.data || {};
    const nextSourceId = SOURCE_FIELDS.map((name) => data[name]).find(Boolean) || sourceId;
    const nextTargetId = TARGET_FIELDS.map((name) => data[name]).find(Boolean) || targetId;
    const nextPredicate = data.predicate || predicate;
    const nextSource = documents.find((document) => document._id === nextSourceId);
    const nextTarget = documents.find((document) => document._id === nextTargetId);
    if (!nextSourceId) nextErrors.source = "Select a source document.";
    else if (!nextSource) nextErrors.source = "Unknown object reference.";
    if (!nextTargetId) nextErrors.target = "Select a target document.";
    else if (!nextTarget) nextErrors.target = "Unknown object reference.";
    const definition = catalog.find(
      (item) => item.id === nextPredicate || item.aliases?.includes(nextPredicate)
    );
    if (!nextPredicate) nextErrors.predicate = "Select or enter a predicate.";
    else if (!definition && !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(nextPredicate))
      nextErrors.predicate = "Predicate must use lowercase snake_case.";
    else if (
      definition &&
      (!compatible(definition.sourceTypes, nextSource?.dtype) ||
        !compatible(definition.targetTypes, nextTarget?.dtype))
    )
      nextErrors.predicate = `Predicate does not support ${nextSource?.dtype || "source"} → ${nextTarget?.dtype || "target"}.`;
    for (const descriptor of optionalDescriptors.filter(
      (item) => added.includes(item.name) && item.required
    )) {
      const parsed = data[descriptor.name];
      if (emptyRequired(parsed))
        nextErrors[descriptor.name] = "This field requires at least one value.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) throw new Error("Fix the highlighted fields.");
    return { nextSourceId, nextTargetId, nextPredicate, nextSource, nextTarget };
  }

  function validateRaw(value) {
    try {
      const parsed = parseJson(value, "Relation JSON", {});
      validateBasic(parsed);
      assertDocument(parsed);
      setRawValidation("");
    } catch (error) {
      setRawValidation(error.message);
    }
  }

  function hydrateFromDraft(draft) {
    const data = draft.data || {};
    const nextSourceId = SOURCE_FIELDS.map((name) => data[name]).find(Boolean) || "";
    const nextTargetId = TARGET_FIELDS.map((name) => data[name]).find(Boolean) || "";
    setSourceId(nextSourceId);
    setTargetId(nextTargetId);
    setPredicate(data.predicate || "");
    setDataset(draft.dataset || "default");
    setDirected(data.directed ?? true);
    setDescription(draft.description || (descriptionField ? data[descriptionField] : "") || "");
    setSources(JSON.stringify(draft.sources || [], null, 2));
    if (startField)
      setStartValue(
        formatSchemaValue(data[startField], descriptorByName.get(startField)?.schema || {})
      );
    if (endField)
      setEndValue(formatSchemaValue(data[endField], descriptorByName.get(endField)?.schema || {}));
    const nextAdded = optionalDescriptors
      .filter((descriptor) => descriptor.name in data)
      .map((descriptor) => descriptor.name);
    setAdded(nextAdded);
    setValues(
      Object.fromEntries(
        optionalDescriptors.map((descriptor) => [
          descriptor.name,
          formatSchemaValue(data[descriptor.name], descriptor.schema)
        ])
      )
    );
    setErrors({});
  }

  function toggleRaw() {
    try {
      if (!rawMode) {
        const nextRaw = JSON.stringify(buildDraft(), null, 2);
        setRaw(nextRaw);
        validateRaw(nextRaw);
      } else {
        hydrateFromDraft(parseJson(raw, "Relation JSON", {}));
        setRawValidation("");
      }
      setRawMode((current) => !current);
    } catch (error) {
      setRawValidation(error.message);
    }
  }

  function generateEmpty() {
    if (
      raw.trim() &&
      raw.trim() !== "{}" &&
      !window.confirm("Replace current JSON?\n\nThis will discard the current editor contents.")
    )
      return;
    const generated = generateEmptyDocument("relation", {
      overrides: { dataset, dtype: "relation" }
    });
    generated.document.data ||= {};
    if (sourceId && sourceField in generated.document.data)
      generated.document.data[sourceField] = sourceId;
    if (targetId && targetField in generated.document.data)
      generated.document.data[targetField] = targetId;
    const nextRaw = JSON.stringify(generated.document, null, 2);
    setRaw(nextRaw);
    setRawMode(true);
    setDirty(true);
    validateRaw(nextRaw);
    if (generated.warnings.length)
      setNotice({ kind: "warning", message: generated.warnings.join(" ") });
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const draft = buildDraft();
      const validated = validateBasic(draft);
      const data = draft.data || {};
      const next = relationDocument
        ? assertDocument(touchDocument(relationDocument, draft))
        : assertDocument(
            createRelation({
              ...draft,
              subject: validated.nextSourceId,
              object: validated.nextTargetId,
              predicate: validated.nextPredicate,
              directed: data.directed ?? directed,
              data
            })
          );
      await execute(
        operation.save(next),
        `${relationDocument ? "Update" : "Create"} relation ${next._id}`
      );
      if (!relationDocument) addDocumentsToActiveGraph([next._id]);
      rememberPredicate(validated.nextPredicate);
      setDirty(false);
      onSaved?.(next);
      onClose();
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
      if (rawMode) setRawValidation(error.message);
    } finally {
      setSaving(false);
    }
  }

  function reverse() {
    if (rawMode) {
      try {
        const draft = parseJson(raw, "Relation JSON", {});
        const data = { ...(draft.data || {}) };
        const currentSource = SOURCE_FIELDS.map((name) => data[name]).find(Boolean) || "";
        const currentTarget = TARGET_FIELDS.map((name) => data[name]).find(Boolean) || "";
        for (const name of SOURCE_FIELDS) delete data[name];
        for (const name of TARGET_FIELDS) delete data[name];
        data[sourceField] = currentTarget;
        data[targetField] = currentSource;
        const nextRaw = JSON.stringify({ ...draft, data }, null, 2);
        setRaw(nextRaw);
        validateRaw(nextRaw);
      } catch (error) {
        setRawValidation(error.message);
      }
    } else {
      setSourceId(targetId);
      setTargetId(sourceId);
    }
    setDirty(true);
  }

  function openFullEditor() {
    try {
      const token = saveEditorDraft(buildDraft(), {
        kind: "relation",
        documentId: relationDocument?._id || "",
        sourceId,
        targetId
      });
      const path = relationDocument
        ? `/documents/${encodeURIComponent(relationDocument._id)}/edit`
        : "/documents/new";
      navigate(
        `${path}?dtype=relation&draft=${encodeURIComponent(token)}&advanced=1&returnTo=graph`
      );
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function remove() {
    if (!relationDocument || !window.confirm("Delete relation?")) return;
    await execute(operation.remove(relationDocument._id), `Delete ${relationDocument._id}`);
    setDirty(false);
    onClose();
  }

  return (
    <GraphModalShell
      title={relationDocument ? "Edit relation" : "New relation"}
      position={position}
      onClose={onClose}
      dirty={dirty}
      className="graph-relation-editor-v2"
    >
      {(requestClose) => (
        <form className="graph-compact-form" onSubmit={submit}>
          {rawMode ? (
            <label className="field full">
              <span>Relation JSON</span>
              <small>object · complete relation document</small>
              <textarea
                className="code-editor graph-json-editor"
                value={raw}
                onChange={(event) => {
                  setRaw(event.target.value);
                  setDirty(true);
                  validateRaw(event.target.value);
                }}
              />
              {rawValidation && <p className="validation-error">{rawValidation}</p>}
            </label>
          ) : (
            <>
              {sourceLocked ? (
                <div className="graph-reference-readonly">
                  <span>Source</span>
                  <strong>{documentLabel(source) || sourceId}</strong>
                  <code>{sourceId}</code>
                  {errors.source && <p className="validation-error">{errors.source}</p>}
                </div>
              ) : (
                <DocumentSelect
                  label="Source"
                  value={sourceId}
                  documents={documents}
                  required
                  error={errors.source}
                  onChange={(value) => {
                    setSourceId(value);
                    setErrors((current) => ({ ...current, source: "" }));
                    setDirty(true);
                  }}
                />
              )}
              <PredicateAutocomplete
                value={predicate}
                onChange={(value) => {
                  setPredicate(value);
                  setErrors((current) => ({ ...current, predicate: "" }));
                  setDirty(true);
                }}
                documents={documents}
                sourceType={source?.dtype}
                targetType={target?.dtype}
                error={errors.predicate}
              />
              {targetLocked ? (
                <div className="graph-reference-readonly">
                  <span>Target</span>
                  <strong>{documentLabel(target) || targetId}</strong>
                  <code>{targetId}</code>
                  {errors.target && <p className="validation-error">{errors.target}</p>}
                </div>
              ) : (
                <DocumentSelect
                  label="Target"
                  value={targetId}
                  documents={documents}
                  required
                  error={errors.target}
                  onChange={(value) => {
                    setTargetId(value);
                    setErrors((current) => ({ ...current, target: "" }));
                    setDirty(true);
                  }}
                />
              )}
              {(startField || endField) && (
                <div className="graph-relation-grid">
                  {startField && (
                    <SchemaField
                      name={startField}
                      fieldSchema={descriptorByName.get(startField)?.schema || {}}
                      value={startValue}
                      onChange={(value) => {
                        setStartValue(value);
                        setDirty(true);
                      }}
                    />
                  )}
                  {endField && (
                    <SchemaField
                      name={endField}
                      fieldSchema={descriptorByName.get(endField)?.schema || {}}
                      value={endValue}
                      onChange={(value) => {
                        setEndValue(value);
                        setDirty(true);
                      }}
                    />
                  )}
                </div>
              )}
              <label className="field">
                <span>Description</span>
                <small>string · long text · optional</small>
                <textarea
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <SchemaField
                name="sources"
                fieldSchema={
                  schema.properties?.sources || { type: "array", items: { type: "string" } }
                }
                value={sources}
                onChange={(value) => {
                  setSources(value);
                  setDirty(true);
                }}
              />
              <label className="field">
                <span>Dataset</span>
                <small>string · required</small>
                <input
                  value={dataset}
                  onChange={(event) => {
                    setDataset(event.target.value);
                    setDirty(true);
                  }}
                  required
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={directed}
                  onChange={(event) => {
                    setDirected(event.target.checked);
                    setDirty(true);
                  }}
                />{" "}
                Directed relation
              </label>
              {added.map((name) => {
                const descriptor = descriptorByName.get(name);
                return (
                  <div className="graph-editor-field" key={name}>
                    <SchemaField
                      name={name}
                      fieldSchema={descriptor?.schema || {}}
                      required={descriptor?.required}
                      value={values[name] ?? ""}
                      onChange={(value) => setOptionalValue(name, value)}
                    />
                    <button
                      className="icon-button danger graph-editor-field-remove"
                      type="button"
                      aria-label={`Remove ${name}`}
                      onClick={() => removeField(name)}
                    >
                      <X size={14} />
                    </button>
                    {errors[name] && <p className="validation-error">{errors[name]}</p>}
                  </div>
                );
              })}
              <FieldPicker descriptors={optionalDescriptors} added={added} onAdd={addField} />
            </>
          )}
          <div className="graph-editor-secondary-actions">
            <button className="button small" type="button" onClick={reverse}>
              <ArrowLeftRight size={14} /> Reverse relation
            </button>
            <button className="button small" type="button" onClick={toggleRaw}>
              <Braces size={14} /> {rawMode ? "Basic" : "Inspect JSON"}
            </button>
            <button className="button small" type="button" onClick={generateEmpty}>
              Generate empty document
            </button>
            <button className="button small" type="button" onClick={openFullEditor}>
              Open full editor
            </button>
          </div>
          <div className="form-actions graph-editor-actions">
            {relationDocument && (
              <button className="button danger" type="button" onClick={remove}>
                <Trash2 size={14} /> Delete
              </button>
            )}
            <span />
            <button className="button" type="button" onClick={requestClose}>
              Cancel
            </button>
            <button className="button primary" disabled={saving}>
              <Save size={14} /> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
    </GraphModalShell>
  );
}
