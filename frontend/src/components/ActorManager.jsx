import { useEffect, useMemo, useState } from "react";
import {
  Braces,
  Code2,
  Copy,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  Trash2
} from "lucide-react";
import { BUILTIN_ACTORS, isBuiltinActor, normalizeActorManifest } from "../lib/actors";
import { validateSource } from "../lib/code-validation";
import { listStarIntelActors } from "../lib/starintel-server";
import { useQuasar } from "../store";
import CodeEditor from "./CodeEditor";
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
    return `${actor.resourceKind} · ${actor.alive ? "alive" : actor.status}`;
  }
  return isBuiltinActor(actor) ? "built-in" : "custom";
}

function contractSummary(contract) {
  return (
    ["targets", "documents", "messages"].flatMap((key) => contract?.[key] || []).join(", ") ||
    "none"
  );
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
  const [serverActors, setServerActors] = useState([]);
  const [serverActorState, setServerActorState] = useState({ state: "idle", message: "" });
  const [registryRefresh, setRegistryRefresh] = useState(0);
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
    return [
      actor.id,
      actor.actorId,
      actor.label,
      actor.description,
      actor.resourceUri,
      actor.sourcePackage,
      actor.status
    ].some((value) =>
      String(value || "")
        .toLowerCase()
        .includes(needle)
    );
  });

  useEffect(() => {
    const serverUrl = String(currentSettings.serverUrl || "").trim();
    if (!serverUrl) {
      setServerActors([]);
      setServerActorState({
        state: "idle",
        message: "Configure a StarIntel server to discover actors."
      });
      return undefined;
    }
    let cancelled = false;
    setServerActorState({ state: "loading", message: "Discovering StarIntel actors…" });
    listStarIntelActors(currentSettings)
      .then((nextActors) => {
        if (cancelled) return;
        setServerActors(nextActors);
        const alive = nextActors.filter((actor) => actor.alive).length;
        setServerActorState({
          state: "active",
          message: `Discovered ${nextActors.length} registry entries; ${alive} alive.`
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
    currentSettings.serverUsername,
    registryRefresh
  ]);

  useEffect(() => {
    const actor = serverActors.find((candidate) => candidate.id === selectedId);
    if (actor) setDraft(actorDraft(actor));
  }, [selectedId, serverActors]);

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
      const formatted = JSON.stringify(JSON.parse(draft.config), null, 2);
      setDraft((current) => ({ ...current, config: formatted }));
      setStatus({ kind: "idle", message: "Manifest JSON formatted." });
    } catch (error) {
      setStatus({ kind: "error", message: error.message });
    }
  }

  async function toggleCustomActors() {
    await persistSettings({ actorsEnabled: !currentSettings.actorsEnabled });
  }

  return (
    <section className="actor-studio page-stack">
      <header className="page-heading actor-studio-heading">
        <div>
          <p className="eyebrow">Actor system</p>
          <h1>Actor studio</h1>
          <p>Create browser actors and inspect the live StarIntel actor registry.</p>
        </div>
        <div className="button-row">
          <button
            className="button"
            type="button"
            disabled={!currentSettings.serverUrl || serverActorState.state === "loading"}
            onClick={() => setRegistryRefresh((value) => value + 1)}
          >
            <RefreshCw size={16} /> Refresh registry
          </button>
          <button className="button" type="button" onClick={createActor}>
            <Plus size={16} /> Create actor
          </button>
          <button
            className="button"
            type="button"
            disabled={serverManaged}
            onClick={duplicateActor}
          >
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
            <span>
              {serverActors.length} server · {serverActors.filter((actor) => actor.alive).length}{" "}
              alive
            </span>
          </div>
          <div className="actor-record-list" role="list" aria-label="Actors">
            <button
              type="button"
              aria-pressed={selectedId === NEW_ACTOR}
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
                  aria-pressed={selectedId === actor.id}
                  key={actor.id}
                  className={selectedId === actor.id ? "active" : ""}
                  onClick={() => selectActor(actor)}
                >
                  {readonly ? <Settings2 size={15} /> : <Code2 size={15} />}
                  <span>
                    <strong>{actor.label}</strong>
                    <small>{actor.actorId || actor.id}</small>
                  </span>
                  <em className={actor.serverManaged ? `actor-status-${actor.status}` : ""}>
                    {actorKind(actor)}
                  </em>
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
                      ? "Registry entries are selectable for inspection; execution remains server-owned"
                      : !selectedIds.length
                        ? "Select one or more graph documents"
                        : !builtin && !currentSettings.actorsEnabled
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
              Registry-managed {selectedActor.resourceKind}: {selectedActor.status} ·{" "}
              {selectedActor.ready ? "ready" : "not ready"} · {selectedActor.sourcePackage}.
              Registry entries are read-only in Quasar.
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
                    This actor is owned by the StarIntel runtime. Quasar discovers its semantic and
                    liveness metadata but does not copy or execute its implementation in the
                    browser.
                  </p>
                </div>
              </div>
            ) : (
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
            ))}

          {editorTab === "config" && (
            <div className="actor-config-editor">
              <div className="actor-config-toolbar">
                <span>{serverManaged ? "Actor registry entry JSON" : "Manifest JSON"}</span>
                <button className="button small" type="button" onClick={formatConfig}>
                  Format JSON
                </button>
              </div>
              <CodeEditor
                value={draft.config}
                readOnly={!editable}
                language="json"
                ariaLabel={serverManaged ? "Actor registry entry JSON" : "Actor manifest JSON"}
                onChange={(config) => setDraft((current) => ({ ...current, config }))}
              />
            </div>
          )}

          {editorTab === "runtime" && (
            <div className="actor-runtime-config">
              <label className="actor-runtime-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(currentSettings.actorsEnabled)}
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
                    <dt>Registry status</dt>
                    <dd>{selectedActor.status}</dd>
                    <dt>Ready</dt>
                    <dd>{selectedActor.ready ? "yes" : "no"}</dd>
                    <dt>Last observed</dt>
                    <dd>{selectedActor.observedAt || "not reported"}</dd>
                    <dt>Resource URI</dt>
                    <dd>{selectedActor.resourceUri}</dd>
                    <dt>Source package</dt>
                    <dd>{selectedActor.sourcePackage}</dd>
                    <dt>Semantic version</dt>
                    <dd>{selectedActor.semantic.version}</dd>
                    <dt>Accepts</dt>
                    <dd>{contractSummary(selectedActor.accepts)}</dd>
                    <dt>Produces</dt>
                    <dd>{contractSummary(selectedActor.produces)}</dd>
                    <dt>Capabilities</dt>
                    <dd>{selectedActor.capabilities.join(", ") || "none"}</dd>
                  </>
                )}
                <dt>Runtime state</dt>
                <dd>
                  {currentSettings.actorsEnabled
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
