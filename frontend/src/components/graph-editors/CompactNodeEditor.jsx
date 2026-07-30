import { useMemo, useState } from "react";
import { Braces, Save, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { assertDocument, createDocument, documentLabel, touchDocument } from "starintel_doc";
import { connectedDocumentIds } from "../../lib/document-delete";
import { operation } from "../../lib/operations";
import {
  dataFieldDescriptorsForDtype,
  dtypeLabel,
  essentialDataFieldsForDtype,
  formatSchemaValue,
  generateEmptyDocument,
  parseSchemaField
} from "../../lib/schema-form";
import { useQuasar } from "../../store";
import { SchemaField } from "../DocumentEditor";
import { FieldPicker, GraphModalShell, parseJson, saveEditorDraft } from "./shared";

function initialValues(document, descriptors, names) {
  return Object.fromEntries(
    names.map((name) => {
      const descriptor = descriptors.find((item) => item.name === name);
      return [name, formatSchemaValue(document?.data?.[name], descriptor?.schema || {})];
    })
  );
}

function emptyRequired(value) {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

export default function CompactNodeEditor({
  document = null,
  objectType = "entity",
  dataset = "default",
  position = null,
  onClose,
  onSaved
}) {
  const navigate = useNavigate();
  const { documents, execute, setNotice, addDocumentsToActiveGraph, workspace } = useQuasar();
  const dtype = document?.dtype || objectType;
  const descriptors = useMemo(() => dataFieldDescriptorsForDtype(dtype), [dtype]);
  const essential = useMemo(() => essentialDataFieldsForDtype(dtype), [dtype]);
  const [added, setAdded] = useState(() =>
    descriptors
      .filter(
        (descriptor) =>
          descriptor.name in (document?.data || {}) && !essential.includes(descriptor.name)
      )
      .map((descriptor) => descriptor.name)
  );
  const [values, setValues] = useState(() =>
    initialValues(document, descriptors, [...essential, ...added])
  );
  const [rawMode, setRawMode] = useState(false);
  const [raw, setRaw] = useState(() =>
    JSON.stringify(document || { dataset, dtype, data: document?.data || {} }, null, 2)
  );
  const [rawValidation, setRawValidation] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const visible = [...new Set([...essential, ...added])];

  function addField(name) {
    setAdded((current) => [...new Set([...current, name])]);
    if (!(name in values)) {
      const descriptor = descriptors.find((item) => item.name === name);
      setValues((current) => ({
        ...current,
        [name]: formatSchemaValue(document?.data?.[name], descriptor?.schema || {})
      }));
    }
    setDirty(true);
  }

  function buildData() {
    const data = { ...(document?.data || {}) };
    const errors = {};
    for (const name of visible) {
      const descriptor = descriptors.find((item) => item.name === name);
      const parsed = parseSchemaField(name, values[name], descriptor?.schema || {}, parseJson);
      if (descriptor?.required && emptyRequired(parsed))
        errors[name] = "This field requires a value.";
      if (parsed === undefined) delete data[name];
      else data[name] = parsed;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length) throw new Error("Fix the highlighted fields.");
    return data;
  }

  function buildDraft() {
    if (rawMode) return parseJson(raw, "Document JSON", {});
    return {
      ...(document || {}),
      dataset: document?.dataset || dataset,
      dtype,
      data: buildData()
    };
  }

  function validateRaw(value) {
    try {
      assertDocument(parseJson(value, "Document JSON", {}));
      setRawValidation("");
    } catch (error) {
      setRawValidation(error.message);
    }
  }

  function toggleRaw() {
    try {
      if (!rawMode) {
        const next = buildDraft();
        const nextRaw = JSON.stringify(next, null, 2);
        setRaw(nextRaw);
        validateRaw(nextRaw);
      } else {
        const parsed = parseJson(raw, "Document JSON", {});
        const nextData = parsed.data || {};
        const nextAdded = descriptors
          .filter(
            (descriptor) => descriptor.name in nextData && !essential.includes(descriptor.name)
          )
          .map((descriptor) => descriptor.name);
        setAdded(nextAdded);
        setValues(initialValues({ data: nextData }, descriptors, [...essential, ...nextAdded]));
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
    const generated = generateEmptyDocument(dtype, {
      overrides: { dataset: document?.dataset || dataset, dtype }
    });
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
      const next = document
        ? assertDocument(touchDocument(document, draft))
        : assertDocument(createDocument(dtype, draft));
      await execute(operation.save(next), `${document ? "Update" : "Create"} ${next._id}`);
      if (!document) {
        const changes = { selectedIds: [next._id] };
        if (position?.position)
          changes.positions = { ...(workspace?.positions || {}), [next._id]: position.position };
        addDocumentsToActiveGraph([next._id], changes);
      }
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

  function openFullEditor() {
    try {
      const draft = buildDraft();
      const token = saveEditorDraft(draft, {
        kind: "node",
        objectType: dtype,
        documentId: document?._id || ""
      });
      const path = document
        ? `/documents/${encodeURIComponent(document._id)}/edit`
        : "/documents/new";
      navigate(`${path}?draft=${encodeURIComponent(token)}&advanced=1&returnTo=graph`);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function remove() {
    if (!document || !window.confirm(`Delete ${documentLabel(document)} and attached relations?`))
      return;
    const ids = connectedDocumentIds(documents, [document._id]);
    await execute(
      operation.batch(
        ids.map((id) => operation.remove(id)),
        `Delete ${document._id}`
      ),
      `Delete ${document._id}`
    );
    setDirty(false);
    onClose();
  }

  return (
    <GraphModalShell
      title={`${document ? "Edit" : "New"} ${dtypeLabel(dtype)}`}
      position={position}
      onClose={onClose}
      dirty={dirty}
      className="graph-node-editor"
    >
      {(requestClose) => (
        <form className="graph-compact-form" onSubmit={submit}>
          {rawMode ? (
            <label className="field full">
              <span>Document JSON</span>
              <small>object · complete document</small>
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
              <div className="graph-editor-type-heading">
                <strong>Fields for {dtype}</strong>
                <span>{document?.dataset || dataset}</span>
              </div>
              <div className="graph-editor-fields">
                {visible.map((name) => {
                  const descriptor = descriptors.find((item) => item.name === name);
                  return (
                    <div className="graph-editor-field" key={name}>
                      <SchemaField
                        name={name}
                        fieldSchema={descriptor?.schema || {}}
                        required={descriptor?.required}
                        value={values[name] ?? ""}
                        onChange={(value) => {
                          setValues((current) => ({ ...current, [name]: value }));
                          setFieldErrors((current) => ({ ...current, [name]: "" }));
                          setDirty(true);
                        }}
                      />
                      {fieldErrors[name] && <p className="validation-error">{fieldErrors[name]}</p>}
                    </div>
                  );
                })}
              </div>
              <FieldPicker descriptors={descriptors} added={visible} onAdd={addField} />
            </>
          )}
          <div className="graph-editor-secondary-actions">
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
            {document && (
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
