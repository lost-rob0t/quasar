import { useEffect, useMemo, useState } from "react";
import { Crown, LockKeyhole, RefreshCw, Send, ServerCog } from "lucide-react";
import { assertDocument, createDocument, documentLabel } from "starintel_doc";
import {
  cpAuthorizeProActorTarget,
  cpProActorManifests,
  cpSystemCapabilities
} from "../control-plane/mutations";
import {
  PRO_ACTOR_MANIFEST_CAPABILITY,
  PRO_ACTOR_SUBMIT_CAPABILITY,
  actorTargetFromDocument,
  defaultConfigForManifest,
  editableConfigProperties,
  editableTargetOptions,
  listProActorManifests,
  normalizeProActorManifest,
  parseManifestValue,
  targetOptionsForRun
} from "../lib/pro-actors";
import { useQuasar } from "../store";

function inputValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function fieldValue(values, name, schema) {
  const value = values[name];
  if (schema.type === "boolean") return Boolean(value);
  return value ?? "";
}

function SchemaField({ name, schema, values, onChange }) {
  const label = schema.title || name.replaceAll("_", " ");
  const value = fieldValue(values, name, schema);
  if (schema.type === "boolean") {
    return (
      <label className="checkbox">
        <input
          type="checkbox"
          checked={value}
          onChange={(event) => onChange(name, event.target.checked)}
        />{" "}
        {label}
      </label>
    );
  }
  if (Array.isArray(schema.enum)) {
    return (
      <label className="field">
        <span>{label}</span>
        <select value={value} onChange={(event) => onChange(name, event.target.value)}>
          <option value="">Default</option>
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (schema.type === "array" || schema.type === "object") {
    return (
      <label className="field">
        <span>{label}</span>
        <textarea
          rows={4}
          value={value}
          onChange={(event) => onChange(name, event.target.value)}
          placeholder={schema.type === "array" ? "[]" : "{}"}
        />
      </label>
    );
  }
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={schema.type === "integer" || schema.type === "number" ? "number" : "text"}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === "integer" ? 1 : schema.type === "number" ? "any" : undefined}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
        placeholder={schema.description || "Default"}
      />
    </label>
  );
}

function normalizedDefaults(manifest) {
  return Object.fromEntries(
    Object.entries(defaultConfigForManifest(manifest)).map(([key, value]) => [key, inputValue(value)])
  );
}

function optionDefaults(manifest) {
  return Object.fromEntries(
    editableTargetOptions(manifest)
      .filter((option) => Object.hasOwn(option, "default"))
      .map((option) => [option.key, inputValue(option.default)])
  );
}

function parseFields(fields, values) {
  const result = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (raw === undefined || raw === "") continue;
    result[field.name] = parseManifestValue(raw, field);
  }
  return result;
}

function parseOptions(options, values) {
  const result = {};
  for (const option of options) {
    const raw = values[option.key];
    if (raw === undefined || raw === "") continue;
    result[option.key] = parseManifestValue(raw, option);
  }
  return result;
}

export default function ProActorManager() {
  const {
    documents,
    selectedDocuments,
    settings,
    submitTarget,
    setNotice,
    controlPlaneStatus
  } = useQuasar();
  const [capabilities, setCapabilities] = useState([]);
  const [manifests, setManifests] = useState([]);
  const [actorId, setActorId] = useState("");
  const [inputId, setInputId] = useState("");
  const [configValues, setConfigValues] = useState({});
  const [optionValues, setOptionValues] = useState({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const hasManifestAccess = capabilities.includes(PRO_ACTOR_MANIFEST_CAPABILITY);
  const hasSubmitAccess = capabilities.includes(PRO_ACTOR_SUBMIT_CAPABILITY);
  const actor = manifests.find((item) => item.id === actorId) || manifests[0] || null;
  const configFields = useMemo(() => editableConfigProperties(actor), [actor]);
  const targetOptions = useMemo(() => editableTargetOptions(actor), [actor]);
  const candidateInputs = useMemo(() => {
    const selected = (selectedDocuments || []).filter((document) => document?.dtype !== "actor-manifest");
    if (selected.length) return selected;
    return (documents || []).filter(
      (document) => document?.dtype !== "actor-manifest" && document?.dtype !== "relation"
    );
  }, [documents, selectedDocuments]);
  const input = candidateInputs.find((document) => document._id === inputId) || candidateInputs[0] || null;

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const nextCapabilities = await cpSystemCapabilities();
      setCapabilities(nextCapabilities);
      if (!nextCapabilities.includes(PRO_ACTOR_MANIFEST_CAPABILITY)) {
        setManifests([]);
        return;
      }
      const remoteDocuments = await cpProActorManifests();
      const remote = remoteDocuments.map(normalizeProActorManifest).filter(Boolean);
      const local = listProActorManifests(documents || []);
      const byId = new Map([...local, ...remote].map((manifest) => [manifest.id, manifest]));
      const next = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
      setManifests(next);
      setActorId((current) => (next.some((item) => item.id === current) ? current : next[0]?.id || ""));
    } catch (cause) {
      setError(cause?.message || String(cause));
      setManifests([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!controlPlaneStatus?.connected) {
      setCapabilities([]);
      setManifests([]);
      return;
    }
    void refresh();
    // Manifests are document-backed; refresh when the canonical corpus changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlPlaneStatus?.connected, documents.length]);

  useEffect(() => {
    if (!actor) {
      setConfigValues({});
      setOptionValues({});
      return;
    }
    setConfigValues(normalizedDefaults(actor));
    setOptionValues(optionDefaults(actor));
  }, [actor?.id]);

  useEffect(() => {
    if (input && !candidateInputs.some((document) => document._id === inputId)) {
      setInputId(input._id);
    }
  }, [candidateInputs, input, inputId]);

  function updateConfig(name, value) {
    setConfigValues((current) => ({ ...current, [name]: value }));
  }

  function updateOption(name, value) {
    setOptionValues((current) => ({ ...current, [name]: value }));
  }

  async function run(event) {
    event.preventDefault();
    if (!actor || !input) return;
    setSubmitting(true);
    setError("");
    try {
      if (!hasSubmitAccess) throw new Error("The active session does not have Pro actor access.");
      if (!settings?.serverUrl) throw new Error("Configure a StarIntel server URL first.");
      const derived = actorTargetFromDocument(actor, input);
      const config = parseFields(configFields, configValues);
      const operationOptions = parseOptions(targetOptions, optionValues);
      const targetDocument = assertDocument(
        createDocument("target", {
          dataset: input.dataset || "default",
          title: `${actor.label} · ${documentLabel(input)}`,
          data: {
            actor: actor.id,
            target: derived.target,
            target_id: input._id,
            target_type: derived.targetType,
            recurring: false,
            delay: 0,
            options: targetOptionsForRun(config, operationOptions, derived.fields)
          }
        })
      );

      // This is the hard hosted entitlement gate. quasar.ws rejects the command
      // before this handler runs unless starintel-biz granted the paid capability.
      await cpAuthorizeProActorTarget(targetDocument);
      await submitTarget(targetDocument, settings);
      setNotice({
        kind: "success",
        message: `Submitted ${documentLabel(input)} to Pro actor ${actor.id}.`
      });
    } catch (cause) {
      const message = cause?.message || String(cause);
      setError(message);
      setNotice({ kind: "error", message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="page-card actor-manager pro-actor-manager">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Paid actor fleet</span>
          <h1>Pro actors</h1>
          <p>
            Canonical actor manifests define the form. Runs become ordinary StarIntel target
            documents; secrets stay on the actor deployment.
          </p>
        </div>
        <button className="button" onClick={refresh} disabled={loading || !controlPlaneStatus?.connected}>
          <RefreshCw size={15} /> {loading ? "Refreshing…" : "Refresh manifests"}
        </button>
      </div>

      {!controlPlaneStatus?.connected && (
        <div className="validation-error">
          <ServerCog size={16} /> Connect the Quasar control plane to discover Pro actors.
        </div>
      )}

      {controlPlaneStatus?.connected && !hasManifestAccess && (
        <div className="empty-state">
          <LockKeyhole size={28} />
          <h2>Pro plan required</h2>
          <p>
            This session does not have <code>{PRO_ACTOR_MANIFEST_CAPABILITY}</code> or{" "}
            <code>{PRO_ACTOR_SUBMIT_CAPABILITY}</code>. Free/basic access cannot discover or run the
            paid actor fleet.
          </p>
        </div>
      )}

      {error && <p className="validation-error">{error}</p>}

      {hasManifestAccess && !loading && !manifests.length && (
        <div className="empty-state">
          <ServerCog size={28} />
          <h2>No pro-actor manifests yet</h2>
          <p>
            Start the actor fleet or publish <code>actor-manifest</code> documents into this
            workspace. Quasar intentionally does not fall back to a hard-coded actor catalog.
          </p>
        </div>
      )}

      {hasManifestAccess && actor && (
        <form className="modal-form" onSubmit={run}>
          <div className="settings-grid">
            <label className="field">
              <span>Pro actor</span>
              <select value={actor.id} onChange={(event) => setActorId(event.target.value)}>
                {manifests.map((manifest) => (
                  <option key={manifest.id} value={manifest.id}>
                    {manifest.label} · {manifest.actorType || manifest.runtime}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Input document</span>
              <select
                value={input?._id || ""}
                onChange={(event) => setInputId(event.target.value)}
                required
              >
                {!candidateInputs.length && <option value="">No documents available</option>}
                {candidateInputs.map((document) => (
                  <option key={document._id} value={document._id}>
                    {documentLabel(document)} · {document.dtype}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="page-card compact-card">
            <div className="button-row">
              <span className="badge"><Crown size={13} /> Pro</span>
              <code>{actor.id}</code>
              <span className="muted">{actor.runtime}</span>
            </div>
            <p className="muted">
              {actor.capabilities.length ? actor.capabilities.join(" · ") : "Manifest-driven actor"}
            </p>
          </div>

          {configFields.length > 0 && (
            <fieldset>
              <legend>Target configuration</legend>
              <div className="settings-grid">
                {configFields.map((field) => (
                  <SchemaField
                    key={field.name}
                    name={field.name}
                    schema={field}
                    values={configValues}
                    onChange={updateConfig}
                  />
                ))}
              </div>
            </fieldset>
          )}

          {targetOptions.length > 0 && (
            <fieldset>
              <legend>Run options</legend>
              <div className="settings-grid">
                {targetOptions.map((option) => (
                  <SchemaField
                    key={option.key}
                    name={option.key}
                    schema={{ ...option, name: option.key }}
                    values={optionValues}
                    onChange={updateOption}
                  />
                ))}
              </div>
            </fieldset>
          )}

          <p className="muted">
            Write-only manifest fields are intentionally hidden. API keys, cookies, sessions, and
            Melissa license material must be configured on the actor deployment, never inside a
            persisted target.
          </p>

          <div className="form-actions">
            <button
              className="button primary"
              disabled={submitting || !input || !hasSubmitAccess || !settings?.serverUrl}
            >
              <Send size={15} /> {submitting ? "Submitting…" : `Run ${actor.label}`}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
