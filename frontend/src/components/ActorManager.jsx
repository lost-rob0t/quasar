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
import { listStarIntelActors } from "../lib/starintel-server";
import { useQuasar } from "../store";
import "../actor-manager.css";

const NEW_ACTOR = "__new_actor__";
const EDITOR_TABS = ["code", "config", "runtime"];

function actorConfig(actor) {
  if (!actor) return {};
  if (actor.serverManaged) return actor.manifest || {};
  const { source: _source, ...config } = actor;
  return config;
}

function actorDraft(actor) {
  return {
    source: actor?.serverManaged ? "" : String(actor?.source || ""),
    config: JSON.stringify(actorConfig(actor), null, 2)
  };
}

function actorKind(actor) {
  if (actor?.serverManaged) {
    const origin = actor.origin === "local" ? "local" : "remote";
    const language = actor.language === "common-lisp" ? "Lisp" : actor.language || "runtime";
    return `${origin} · ${language}`;
  }
  return isBuiltinActor(actor) ? "built-in" : "custom";
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

function insertIndent(event, value, onChange) {
  if (event.key !== "Tab") return;
  event.preventDefault();
  const start = event.currentTarget.selectionStart;
  const end = event.currentTarget.selectionEnd;
  const next = `${value.slice(0, start)}  ${value.slice(end)}`;
  onChange(next);
  requestAnimationFrame(() => {
    event.currentTarget.selectionStart = start + 2;
    event.currentTarget.selectionEnd = start + 2;
  });
}

export default function ActorManager() {
  const { actors, persistSettings, runActor, selectedIds, settings, setNotice } = useQuasar();
  const currentSettings = settings || {};
  const customActors = Array.isArray(currentSettings.actors) ? currentSettings.actors : [];
  const [serverActors, setServerActors] = useState([]);
  const [serverActorState, setServerActorState] = useState({ state: "idle", message: "" });
  const allActors = useMemo(
    () => [...BUILTIN_ACTORS, ...customActors, ...serverActors],
    [customActors, serverActors]
  );
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(allActors[0]?.id || NEW_ACTOR);
  const [editorTab, setEditorTab] = useState("code");
  const [draft, setDraft] = useState(() => actorDraft(allActors[0] || defaultActor()));
  const [status, setStatus] = useState({ kind: "idle", message: "" });

  const selectedActor =
    selectedId === NEW_ACTOR ? null : allActors.find((actor) => actor.id === selectedId) || null;
  const builtin = Boolean(selectedActor && isBuiltinActor(selectedActor));
  const serverManaged = Boolean(selectedActor?.serverManaged);
  const editable = !builtin && !serverManaged;
  const canRunSelected = Boolean(
    selectedActor &&
      !serverManaged &&
      selectedIds.length &&
      (builtin || currentSettings.actorsEnabled)
  );
  const filteredActors = allActors.filter((actor) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [actor.id, actor.actorId, actor.label, actor.description, actor.serviceId, actor.language].some(
      (value) =>
        String(value || "")
          .toLowerCase()
          .includes(needle)
    );
  });

  useEffect(() => {
    const serverUrl = String(currentSettings.serverUrl || "").trim();
    if (!serverUrl) {
      setServerActors([]);
      setServerActorState({ state: "idle", message: "Configure a StarIntel server to discover actors." });
      return undefined;
    }
    let cancelled = false;
    setServerActorState({ state: "loading", message: "Discovering StarIntel actors…" });
    listStarIntelActors(currentSettings)
      .then((nextActors) => {
        if (cancelled) return;
        setServerActors(nextActors);
        setServerActorState({
          state: "active",
          message: `Discovered ${nextActors.length} StarIntel server actor(s).`
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setServerActors([]);
        setServerActorState({ state: "error", message: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, [
    currentSettings.serverPassword,
    currentSettings.serverToken,
    currentSettings.serverUrl,
    currentSettings.serverUsername
  ]);

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
    if (!selectedActor || builtin || serverManaged) return;
    if (!window.confirm(`Delete ${selectedActor.label}?`)) return;
    const nextActors = customActors.filter((actor) => actor.id !== selectedActor.id);
    await persistSettings({ actors: nextActors });
    const fallback = [...BUILTIN_ACTORS, ...nextActors, ...serverActors][0] || null;
    setSelectedId(fallback?.id || NEW_ACTOR);
    setDraft(actorDraft(fallback || defaultActor()));
    setStatus({ kind: "success", message: `Deleted ${selectedActor.label}.` });
  }

  async function duplicateActor() {
    if (serverManaged) return;
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
    if (!selectedActor || serverManaged) return;
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
          <p>Create browser actors and inspect local or remote StarIntel actor deployments.</p>
        </div>
        <div className="button-row">
          <button className="button" type="button" onClick={createActor}>
            <Plus size={16} /> Create actor
          </button>
          <button className="button" type="button" disabled={serverManaged} onClick={duplicateActor}>
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
            <span>{serverActors.length} server</span>
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
              const readonly = isBuiltinActor(actor) || actor.serverManaged;
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
                    <small>{actor.actorId || actor.id}</small>
                  </span>
                  <em>{actorKind(actor)}</em>
                </button>
              );
            })}
          </div>
          {serverActorState.message && (
            <p className={serverActorState.state === "error" ? "validation-error" : "muted"}>
              {serverActorState.message}
            </p>
          )}
        </aside>

        <section className="panel actor-editor-panel">
          <div className="section-heading actor-editor-heading">
            <div>
              <h2>{selectedActor?.label || "New actor"}</h2>
              <span>{selectedActor?.actorId || selectedActor?.id || "Unsaved"}</span>
            </div>
            <div className="button-row">
              {selectedActor && (
                <button
                  className="button small"
                  type="button"
                  disabled={!canRunSelected}
                  title={
                    serverManaged
                      ? "Server-managed actors execute through StarIntel target dispatch, not the browser sandbox"
                      : !selectedIds.length
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
                disabled={!selectedActor || builtin || serverManaged}
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
          {serverManaged && (
            <div className="actor-studio-banner">
              Server-managed actor: {selectedActor.origin} via {selectedActor.serviceId} · {selectedActor.language} · {selectedActor.runtime?.transport || "runtime"}. Deployment manifests are read-only in Quasar.
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

          {editorTab === "code" &&
            (serverManaged ? (
              <div className="actor-security-note">
                <Settings2 size={20} />
                <div>
                  <strong>No browser source</strong>
                  <p>
                    This actor is owned by the StarIntel runtime. Quasar discovers its deployment
                    metadata but does not copy or execute its implementation in the browser.
                  </p>
                </div>
              </div>
            ) : (
              <label className="actor-code-field">
                <span>JavaScript actor function</span>
                <textarea
                  className="actor-code-editor"
                  value={draft.source}
                  readOnly={!editable}
                  spellCheck="false"
                  onKeyDown={(event) =>
                    insertIndent(event, draft.source, (source) =>
                      setDraft((current) => ({ ...current, source }))
                    )
                  }
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, source: event.target.value }))
                  }
                />
              </label>
            ))}

          {editorTab === "config" && (
            <div className="actor-config-editor">
              <div className="actor-config-toolbar">
                <span>{serverManaged ? "Deployment manifest JSON" : "Manifest JSON"}</span>
                <button className="button small" type="button" onClick={formatConfig}>
                  Format JSON
                </button>
              </div>
              <textarea
                className="actor-code-editor"
                value={draft.config}
                readOnly={!editable}
                spellCheck="false"
                onKeyDown={(event) =>
                  insertIndent(event, draft.config, (config) =>
                    setDraft((current) => ({ ...current, config }))
                  )
                }
                onChange={(event) =>
                  setDraft((current) => ({ ...current, config: event.target.value }))
                }
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
                    directly. Server-managed actors stay outside this browser execution boundary.
                  </p>
                </div>
              </div>
              <dl className="actor-runtime-details">
                <dt>Selected documents</dt>
                <dd>{selectedIds.length}</dd>
                <dt>Browser actors</dt>
                <dd>{actors.length}</dd>
                <dt>StarIntel server actors</dt>
                <dd>{serverActors.length}</dd>
                <dt>Custom definitions</dt>
                <dd>{customActors.length}</dd>
                {serverManaged && (
                  <>
                    <dt>Selected origin</dt>
                    <dd>{selectedActor.origin}</dd>
                    <dt>Selected service</dt>
                    <dd>{selectedActor.serviceId}</dd>
                    <dt>Selected language</dt>
                    <dd>{selectedActor.language}</dd>
                    <dt>Selected transport</dt>
                    <dd>{selectedActor.runtime?.transport || "unknown"}</dd>
                  </>
                )}
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
