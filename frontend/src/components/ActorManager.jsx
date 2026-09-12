import { useEffect, useMemo, useState } from "react";
import {
  Braces,
  Code2,
  Copy,
  Play,
  Plus,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  Trash2
} from "lucide-react";
import { BUILTIN_ACTORS, isBuiltinActor, normalizeActorManifest } from "../lib/actors";
import { validateSource } from "../lib/code-validation";
import { useQuasar } from "../store";
import CodeEditor from "./CodeEditor";
import "../actor-manager.css";

const NEW_ACTOR = "__new_actor__";
const EDITOR_TABS = ["code", "config", "runtime"];

function actorConfig(actor) {
  if (!actor) return {};
  const { source: _source, ...config } = actor;
  return config;
}

function actorDraft(actor) {
  return {
    source: String(actor?.source || ""),
    config: JSON.stringify(actorConfig(actor), null, 2)
  };
}

function defaultActor() {
  const suffix = crypto.randomUUID().slice(0, 8);
  return {
    id: `quasar.actor.custom-${suffix}`,
    label: "Custom actor",
    description: "Browser actor created in Quasar",
    version: 1,
    accepts: ["*"],
    triggers: [],
    capabilities: [],
    limits: {},
    minSelection: 1,
    maxSelection: 32,
    source: `(context, api) => {
  return {
    documents: [],
    message: "Actor completed."
  };
}`
  };
}

function syntaxErrorMessage(validation) {
  const failure = validation.diagnostics[0];
  if (!failure) return "Invalid JavaScript actor source";
  const location = failure.line && failure.column ? ` at ${failure.line}:${failure.column}` : "";
  return `Invalid JavaScript actor source${location}: ${failure.message}`;
}

export default function ActorManager() {
  const { actors, persistSettings, runActor, selectedIds, settings, setNotice } = useQuasar();
  const currentSettings = settings || {};
  const customActors = Array.isArray(currentSettings.actors) ? currentSettings.actors : [];
  const allActors = useMemo(() => [...BUILTIN_ACTORS, ...customActors], [customActors]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(allActors[0]?.id || NEW_ACTOR);
  const [editorTab, setEditorTab] = useState("code");
  const [draft, setDraft] = useState(() => actorDraft(allActors[0] || defaultActor()));
  const [status, setStatus] = useState({ kind: "idle", message: "" });

  const selectedActor =
    selectedId === NEW_ACTOR ? null : allActors.find((actor) => actor.id === selectedId) || null;
  const builtin = Boolean(selectedActor && isBuiltinActor(selectedActor));
  const editable = !builtin;
  const canRunSelected = Boolean(
    selectedActor && selectedIds.length && (builtin || currentSettings.actorsEnabled)
  );
  const filteredActors = allActors.filter((actor) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [actor.id, actor.label, actor.description].some((value) =>
      String(value || "")
        .toLowerCase()
        .includes(needle)
    );
  });

  useEffect(() => {
    if (selectedId === NEW_ACTOR) return;
    if (allActors.some((actor) => actor.id === selectedId)) return;
    const fallback = allActors[0] || null;
    setSelectedId(fallback?.id || NEW_ACTOR);
    setDraft(actorDraft(fallback || defaultActor()));
  }, [allActors, selectedId]);

  function selectActor(actor) {
    setSelectedId(actor.id);
    setDraft(actorDraft(actor));
    setStatus({ kind: "idle", message: "" });
  }

  function createActor() {
    const actor = defaultActor();
    setSelectedId(NEW_ACTOR);
    setDraft(actorDraft(actor));
    setEditorTab("code");
    setStatus({ kind: "idle", message: "" });
  }

  async function saveActor() {
    try {
      const sourceValidation = validateSource(draft.source, "javascript", {
        javascriptExpression: true
      });
      if (!sourceValidation.valid) throw new Error(syntaxErrorMessage(sourceValidation));
      const parsed = JSON.parse(draft.config);
      const normalized = normalizeActorManifest({ ...parsed, source: draft.source });
      const occupied = allActors.find(
        (actor) => actor.id === normalized.id && actor.id !== selectedActor?.id
      );
      if (occupied) throw new Error(`Actor ID already exists: ${normalized.id}`);
      if (BUILTIN_ACTORS.some((actor) => actor.id === normalized.id)) {
        throw new Error("Built-in actor IDs are reserved");
      }
      const nextActors = selectedActor
        ? customActors.map((actor) => (actor.id === selectedActor.id ? normalized : actor))
        : [...customActors, normalized];
      await persistSettings({ actors: nextActors });
      setSelectedId(normalized.id);
      setDraft(actorDraft(normalized));
      setStatus({ kind: "success", message: `Saved ${normalized.label}.` });
      setNotice?.({ kind: "success", message: `Actor saved: ${normalized.label}` });
    } catch (error) {
      setStatus({ kind: "error", message: error.message });
    }
  }

  async function deleteActor() {
    if (!selectedActor || builtin) return;
    if (!window.confirm(`Delete ${selectedActor.label}?`)) return;
    const nextActors = customActors.filter((actor) => actor.id !== selectedActor.id);
    await persistSettings({ actors: nextActors });
    const fallback = [...BUILTIN_ACTORS, ...nextActors][0] || null;
    setSelectedId(fallback?.id || NEW_ACTOR);
    setDraft(actorDraft(fallback || defaultActor()));
    setStatus({ kind: "success", message: `Deleted ${selectedActor.label}.` });
  }

  async function duplicateActor() {
    const source =
      selectedActor ||
      normalizeActorManifest({
        ...JSON.parse(draft.config),
        source: draft.source
      });
    const suffix = crypto.randomUUID().slice(0, 8);
    const copy = normalizeActorManifest({
      ...source,
      id: `${source.id}.copy-${suffix}`,
      label: `${source.label} copy`,
      source: source.source
    });
    await persistSettings({ actors: [...customActors, copy] });
    setSelectedId(copy.id);
    setDraft(actorDraft(copy));
    setEditorTab("code");
    setStatus({ kind: "success", message: `Created ${copy.label}.` });
  }

  async function runSelectedActor() {
    if (!selectedActor) return;
    try {
      setStatus({ kind: "running", message: `Running ${selectedActor.label}…` });
      const result = await runActor(selectedActor, selectedIds);
      setStatus({ kind: "success", message: result.message || "Actor completed." });
    } catch (error) {
      setStatus({ kind: "error", message: error.message });
    }
  }

  function formatConfig() {
    try {
      setDraft((current) => ({
        ...current,
        config: JSON.stringify(JSON.parse(current.config), null, 2)
      }));
      setStatus({ kind: "idle", message: "Manifest JSON formatted." });
    } catch (error) {
      setStatus({ kind: "error", message: error.message });
    }
  }

  async function toggleCustomActors() {
    await persistSettings({ actorsEnabled: !settings.actorsEnabled });
  }

  return (
    <section className="actor-studio page-stack">
      <header className="page-heading actor-studio-heading">
        <div>
          <p className="eyebrow">Actor system</p>
          <h1>Actor studio</h1>
          <p>Create, inspect, update, clone, and delete browser actor manifests.</p>
        </div>
        <div className="button-row">
          <button className="button" type="button" onClick={createActor}>
            <Plus size={16} /> Create actor
          </button>
          <button className="button" type="button" onClick={duplicateActor}>
            <Copy size={16} /> Clone
          </button>
          <button className="button primary" type="button" disabled={!editable} onClick={saveActor}>
            <Save size={16} /> Save
          </button>
        </div>
      </header>

      <div className="actor-studio-grid">
        <aside className="panel actor-browser">
          <label className="actor-search">
            <Search size={15} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search actors"
              aria-label="Search actors"
            />
          </label>
          <div className="actor-browser-summary">
            <span>{BUILTIN_ACTORS.length} built-in</span>
            <span>{customActors.length} custom</span>
          </div>
          <div className="actor-record-list" role="listbox" aria-label="Actors">
            <button
              type="button"
              className={selectedId === NEW_ACTOR ? "active" : ""}
              onClick={createActor}
            >
              <Plus size={15} />
              <span>
                <strong>New actor</strong>
                <small>Unsaved manifest</small>
              </span>
            </button>
            {filteredActors.map((actor) => {
              const readonly = isBuiltinActor(actor);
              return (
                <button
                  type="button"
                  key={actor.id}
                  className={selectedId === actor.id ? "active" : ""}
                  onClick={() => selectActor(actor)}
                >
                  {readonly ? <Settings2 size={15} /> : <Code2 size={15} />}
                  <span>
                    <strong>{actor.label}</strong>
                    <small>{actor.id}</small>
                  </span>
                  <em>{readonly ? "built-in" : "custom"}</em>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="panel actor-editor-panel">
          <div className="section-heading actor-editor-heading">
            <div>
              <h2>{selectedActor?.label || "New actor"}</h2>
              <span>{selectedActor?.id || "Unsaved"}</span>
            </div>
            <div className="button-row">
              {selectedActor && (
                <button
                  className="button small"
                  type="button"
                  disabled={!canRunSelected}
                  title={
                    !selectedIds.length
                      ? "Select one or more graph documents"
                      : !builtin && !settings.actorsEnabled
                        ? "Enable custom actor execution in Runtime"
                        : builtin
                          ? "Run trusted built-in actor against the current graph selection"
                          : "Run custom actor in a disposable opaque-origin sandbox"
                  }
                  onClick={runSelectedActor}
                >
                  <Play size={14} /> Run selected
                </button>
              )}
              <button
                className="button danger small"
                type="button"
                disabled={!selectedActor || builtin}
                onClick={deleteActor}
              >
                <Trash2 size={14} /> Delete
              </button>
            </div>
          </div>

          {builtin && (
            <div className="actor-studio-banner">
              Built-in actors are read-only. Clone this actor to create an editable copy.
            </div>
          )}

          <nav className="actor-editor-tabs" aria-label="Actor editor">
            {EDITOR_TABS.map((tab) => (
              <button
                type="button"
                key={tab}
                className={editorTab === tab ? "active" : ""}
                onClick={() => setEditorTab(tab)}
              >
                {tab === "code" && <Code2 size={15} />}
                {tab === "config" && <Braces size={15} />}
                {tab === "runtime" && <Settings2 size={15} />}
                {tab}
              </button>
            ))}
          </nav>

          {editorTab === "code" && (
            <div className="actor-code-field">
              <span>JavaScript actor function</span>
              <CodeEditor
                value={draft.source}
                readOnly={!editable}
                language="javascript"
                validationMode="expression"
                ariaLabel="JavaScript actor function"
                onChange={(source) => setDraft((current) => ({ ...current, source }))}
              />
            </div>
          )}

          {editorTab === "config" && (
            <div className="actor-config-editor">
              <div className="actor-config-toolbar">
                <span>Manifest JSON</span>
                <button className="button small" type="button" onClick={formatConfig}>
                  Format JSON
                </button>
              </div>
              <CodeEditor
                value={draft.config}
                readOnly={!editable}
                language="json"
                ariaLabel="Actor manifest JSON"
                onChange={(config) => setDraft((current) => ({ ...current, config }))}
              />
            </div>
          )}

          {editorTab === "runtime" && (
            <div className="actor-runtime-config">
              <label className="actor-runtime-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(settings.actorsEnabled)}
                  onChange={toggleCustomActors}
                />
                <span>
                  <strong>Enable custom actor execution</strong>
                  <small>
                    Custom actors run inside a disposable sandboxed iframe with an opaque origin.
                  </small>
                </span>
              </label>
              <div className="actor-security-note">
                <ShieldAlert size={20} />
                <div>
                  <strong>Execution boundary</strong>
                  <p>
                    Custom code cannot access Quasar&apos;s origin, DOM, storage, or network
                    directly. Declared capabilities are mediated by Quasar.
                  </p>
                </div>
              </div>
              <dl className="actor-runtime-details">
                <dt>Selected documents</dt>
                <dd>{selectedIds.length}</dd>
                <dt>Loaded actors</dt>
                <dd>{actors.length}</dd>
                <dt>Custom definitions</dt>
                <dd>{customActors.length}</dd>
                <dt>Runtime state</dt>
                <dd>
                  {settings.actorsEnabled
                    ? "custom execution enabled"
                    : "custom execution disabled"}
                </dd>
              </dl>
            </div>
          )}

          {status.message && (
            <div className={`actor-editor-status ${status.kind}`} role="status">
              {status.message}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
