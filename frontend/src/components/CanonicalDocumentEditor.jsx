import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { dtypes } from "starintel_doc";
import {
  parseBrowserDocumentJson,
  assertDocument,
  documentSchema,
  schema,
  toCanonicalDocument,
  toLegacyUiDocument
} from "../lib/canonical-document";
import { operation } from "../lib/operations";
import { useQuasar } from "../store";

function resolve(node) {
  if (node.anyOf) return resolve(node.anyOf.find((item) => item.type !== "null") || node.anyOf[0]);
  return node.$ref ? resolve(schema.$defs[node.$ref.split("/").at(-1)]) : node;
}

export function createCanonicalDraft(
  dtype,
  dataset = "default",
  id = globalThis.crypto.randomUUID()
) {
  documentSchema(dtype);
  return { id, dataset, dtype, schemaVersion: "0.10.1" };
}

export function parseCanonicalField(text, field) {
  const nullable = field.$ref ? schema.$defs[field.$ref.split("/").at(-1)] : field;
  if (text === "null" && nullable?.anyOf?.some((item) => item.type === "null")) return null;
  const definition = resolve(field);
  if (definition.type === "string") return text;
  if (text === "") return undefined;
  const value = parseBrowserDocumentJson(text);
  if (definition.type === "integer" && !Number.isSafeInteger(value)) {
    throw new TypeError(
      "Enter a safe whole integer; exact larger values must be imported using the canonical adapter"
    );
  }
  return value;
}

function Editor({ initial, mode, params, draftToken }) {
  const {
    execute,
    setNotice,
    documents = [],
    workspace,
    addDocumentsToActiveGraph,
    runTargetActors
  } = useQuasar();
  const navigate = useNavigate();
  const [document, setDocument] = useState(initial);
  const [raw, setRaw] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalidFields, setInvalidFields] = useState({});
  const definition = documentSchema(document.dtype);
  const required = new Set(definition.required);
  const fields = [...new Set([...definition.required, ...Object.keys(document)])];
  const available = Object.keys(definition.properties).filter((name) => !fields.includes(name));
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (raw === null && Object.values(invalidFields).some(Boolean))
        throw new TypeError("Correct invalid field values before saving");
      const candidate = raw === null ? { ...document } : parseBrowserDocumentJson(raw);
      if (raw === null) {
        candidate.updatedAt = Math.floor(Date.now() / 1000);
        if (mode !== "edit" && candidate.createdAt === undefined)
          candidate.createdAt = candidate.updatedAt;
      }
      const validated = assertDocument(candidate);
      if (mode === "edit" && validated.id !== initial.id)
        throw new TypeError("An edit cannot change the document ID");
      if (mode !== "edit" && documents.some((item) => (item.id || item._id) === validated.id))
        throw new TypeError("That document ID already exists; edit the existing record instead");
      await execute(
        operation.save(validated),
        `${mode === "edit" ? "Update" : "Create"} ${validated.id}`
      );
      setNotice?.({ kind: "success", message: "Saved canonical StarIntel 0.10.1 document" });
      if (draftToken && typeof sessionStorage !== "undefined")
        sessionStorage.removeItem(`quasar.editor-draft.v1:${draftToken}`);
      if (mode !== "edit" && validated.dtype === "target")
        await runTargetActors?.(toLegacyUiDocument(validated));
      if (params.get("returnTo") === "graph") {
        if (mode !== "edit") {
          const x = Number(params.get("x")),
            y = Number(params.get("y"));
          const position =
            params.has("x") && params.has("y") && Number.isFinite(x) && Number.isFinite(y);
          addDocumentsToActiveGraph?.([validated.id], {
            selectedIds: [validated.id],
            ...(position
              ? { positions: { ...(workspace?.positions || {}), [validated.id]: { x, y } } }
              : {})
          });
        }
        navigate(`/graph?node=${encodeURIComponent(validated.id)}`, {
          state: { revealUnreviewed: true, createdIds: mode === "edit" ? [] : [validated.id] }
        });
      } else navigate(`/documents/${encodeURIComponent(validated.id)}`);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel document-editor">
      <h1>{mode === "edit" ? "Edit" : "New"} document</h1>
      <p>StarIntel 0.10.1 · Flat canonical fields from Star Language</p>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={save}>
        <label className="field">
          Document type
          <select
            value={document.dtype}
            disabled={mode === "edit" || busy}
            onChange={(event) => {
              setDocument(createCanonicalDraft(event.target.value, document.dataset, document.id));
              setRaw(null);
            }}
          >
            {dtypes.map((dtype) => (
              <option key={dtype}>{dtype}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (raw === null) setRaw(JSON.stringify(document, null, 2));
            else {
              try {
                setDocument(assertDocument(parseBrowserDocumentJson(raw)));
                setRaw(null);
                setError("");
              } catch (failure) {
                setError(failure.message);
              }
            }
          }}
        >
          {raw === null ? "Edit raw JSON" : "Use fields"}
        </button>
        {raw !== null ? (
          <textarea
            aria-label="Canonical document JSON"
            rows={24}
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
          />
        ) : (
          <>
            <div className="form-grid">
              {fields.map((name) => {
                const field = definition.properties[name];
                if (!field)
                  return (
                    <p role="alert" key={name}>
                      Unknown field: {name}
                    </p>
                  );
                return (
                  <CanonicalField
                    key={`${document.dtype}:${name}`}
                    name={name}
                    field={field}
                    value={document[name]}
                    required={required.has(name)}
                    disabled={
                      busy ||
                      name === "schemaVersion" ||
                      name === "dtype" ||
                      (mode === "edit" && name === "id")
                    }
                    onChange={(value) => {
                      setDocument((current) => {
                        const next = { ...current };
                        if (value === undefined) delete next[name];
                        else next[name] = value;
                        return next;
                      });
                    }}
                    onError={(message) => {
                      setError(message);
                      setInvalidFields((current) => ({ ...current, [name]: Boolean(message) }));
                    }}
                  />
                );
              })}
            </div>
            <label className="field">
              Add optional field
              <select
                value=""
                onChange={(event) => {
                  const name = event.target.value;
                  if (!name) return;
                  const field = resolve(definition.properties[name]);
                  setDocument((current) => ({
                    ...current,
                    [name]:
                      field.type === "string"
                        ? ""
                        : field.type === "array"
                          ? []
                          : field.type === "object"
                            ? {}
                            : field.type === "boolean"
                              ? false
                              : 0
                  }));
                }}
              >
                <option value="">Choose a generated field…</option>
                {available.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save document"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => navigate(params.get("returnTo") === "graph" ? "/graph" : "/documents")}
        >
          Cancel
        </button>
      </form>
    </section>
  );
}

function CanonicalField({ name, field, value, required, disabled, onChange, onError }) {
  const definition = resolve(field);
  const [text, setText] = useState(
    typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2)
  );
  const update = (event) => {
    const next = event.target.value;
    setText(next);
    try {
      onChange(parseCanonicalField(next, field));
      onError("");
    } catch (failure) {
      onError(`${name}: ${failure.message}`);
    }
  };
  return (
    <label className="field">
      <span>
        {name}
        {required ? " *" : ""}
      </span>
      {definition.enum ? (
        <select required={required} disabled={disabled} value={text} onChange={update}>
          <option value="">Select…</option>
          {definition.enum.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      ) : ["object", "array"].includes(definition.type) ? (
        <textarea aria-label={name} disabled={disabled} rows={4} value={text} onChange={update} />
      ) : (
        <input
          aria-label={name}
          required={required}
          disabled={disabled}
          value={text}
          onChange={update}
        />
      )}
      {!required && !disabled && (
        <button type="button" onClick={() => onChange(undefined)}>
          Remove field
        </button>
      )}
    </label>
  );
}

export default function CanonicalDocumentEditor({ mode }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { documents } = useQuasar();
  const existing = documents.find((document) => (document.id || document._id) === id);
  const draftToken = params.get("draft");
  let initial;
  try {
    const draftText =
      draftToken && typeof sessionStorage !== "undefined"
        ? sessionStorage.getItem(`quasar.editor-draft.v1:${draftToken}`)
        : null;
    const draft = draftText ? parseBrowserDocumentJson(draftText) : null;
    if (mode === "edit" && !existing && !draft)
      return <p role="alert">Document is not available yet.</p>;
    initial =
      draft || existing
        ? toCanonicalDocument(draft || existing, { allowLegacy090: true })
        : createCanonicalDraft(params.get("dtype") || "person", params.get("dataset") || "default");
  } catch (failure) {
    return (
      <p role="alert">
        This historical document requires explicit migration before editing: {failure.message}
      </p>
    );
  }
  return (
    <Editor
      key={`${mode}:${id || draftToken || "new"}:${params.get("dtype") || "person"}:${params.get("dataset") || "default"}`}
      mode={mode}
      params={params}
      draftToken={draftToken}
      initial={initial}
    />
  );
}
