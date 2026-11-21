import { useEffect, useMemo, useState } from "react";
import { Play, RefreshCw, Search, Settings2 } from "lucide-react";
import { BUILTIN_ACTORS, actorExecutionBlocked, isBuiltinActor } from "../lib/actors";
import { listStarIntelActors } from "../lib/starintel-server";
import { useQuasar } from "../store";
import CodeEditor from "./CodeEditor";
import ServerActorTarget from "./ServerActorTarget";
import "../actor-manager.css";

function actorConfig(actor) {
  if (!actor) return {};
  if (actor.serverManaged) return actor.manifest || {};
  const { source: _source, ...config } = actor;
  return config;
}

function actorDraft(actor) {
  return {
    config: JSON.stringify(actorConfig(actor), null, 2)
  };
}

function actorKind(actor) {
  if (actor?.runtime === "pro-actor-fleet") {
    // The pro-actor fleet is retired: these run locally via the
    // control-plane python checkout, not on a remote fleet.
    return "local · python";
  }
  if (actor?.serverManaged) {
    return `${actor.resourceKind} · ${actor.alive ? "alive" : actor.status}`;
  }
  return isBuiltinActor(actor) ? "built-in" : "shipped pack";
}

function contractSummary(contract) {
  return (
    ["targets", "documents", "messages"].flatMap((key) => contract?.[key] || []).join(", ") ||
    "none"
  );
}

export default function ActorManager() {
  const { actors, persistSettings, runActor, selectedIds, settings, setNotice } = useQuasar();
  const currentSettings = settings || {};
  const registryActors = useMemo(
    () => actors.filter((actor) => actor?.runtime === "pro-actor-fleet"),
    [actors]
  );
  const [targetInput, setTargetInput] = useState("");
  const [serverActors, setServerActors] = useState([]);
  const [serverActorState, setServerActorState] = useState({ state: "idle", message: "" });
  const [registryRefresh, setRegistryRefresh] = useState(0);
  const allActors = useMemo(
    () => [...BUILTIN_ACTORS, ...registryActors, ...serverActors],
    [registryActors, serverActors]
  );
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(allActors[0]?.id || "");
  const [editorTab, setEditorTab] = useState("config");
  const [draft, setDraft] = useState(() => actorDraft(allActors[0] || null));
  const [status, setStatus] = useState({ kind: "idle", message: "" });

  const selectedActor = allActors.find((actor) => actor.id === selectedId) || null;
  const builtin = Boolean(selectedActor && isBuiltinActor(selectedActor));
  const serverManaged = Boolean(selectedActor?.serverManaged);
  const localFleet = Boolean(selectedActor?.runtime === "pro-actor-fleet");
  // The pro-actor fleet is retired: registry actors run LOCALLY through the
  // control-plane python checkout, so the browser-actor gates (e2e
  // verification, selection requirement) do not apply.
  const blocked = Boolean(
    selectedActor && !localFleet && actorExecutionBlocked(selectedActor, currentSettings)
  );
  const canRunSelected = Boolean(
    selectedActor &&
    !blocked &&
    (localFleet ? Boolean(targetInput.trim()) : !serverManaged && selectedIds.length)
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
    setServerActors([]);
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
    if (allActors.some((actor) => actor.id === selectedId)) return;
    const fallback = allActors[0] || null;
    setSelectedId(fallback?.id || "");
    setDraft(actorDraft(fallback));
  }, [allActors, selectedId]);

  function selectActor(actor) {
    setSelectedId(actor.id);
    setDraft(actorDraft(actor));
    setStatus({ kind: "idle", message: "" });
  }

  async function runSelectedActor() {
    if (!selectedActor) return;
    // serverManaged registry entries are manifest-readonly but fleet actors
    // still run locally (control-plane python checkout).
    if (serverManaged && !localFleet) return;
    try {
      setStatus({ kind: "running", message: `Running ${selectedActor.label}…` });
      const result = await runActor(
        selectedActor,
        selectedIds,
        localFleet ? { target: targetInput } : undefined
      );
      setStatus({
        kind: "success",
        message:
          typeof result?.message === "string" && result.message
            ? result.message
            : "Actor completed."
      });
    } catch (error) {
      setStatus({ kind: "error", message: error.message });
    }
  }

  async function enableExperimentalActors() {
    try {
      await persistSettings({ enableExperimentalActors: true });
      setNotice?.({
        kind: "success",
        message: "Experimental built-in actors enabled."
      });
    } catch (error) {
      setStatus({ kind: "error", message: error.message });
    }
  }

  return (
    <section className="actor-studio page-stack">
      <header className="page-heading actor-studio-heading">
        <div>
          <p className="eyebrow">Actor system</p>
          <h1>Actor studio</h1>
          <p>
            Inspect built-in actors and the live StarIntel actor registry; run local fleet actors.
          </p>
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
            <span>
              {serverActors.length} server · {serverActors.filter((actor) => actor.alive).length}{" "}
              alive
            </span>
          </div>
          <div className="actor-record-list" role="list" aria-label="Actors">
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
                  <Settings2 size={15} />
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
              <h2>{selectedActor?.label || "No actor selected"}</h2>
              <span>{selectedActor?.actorId || selectedActor?.id || "—"}</span>
            </div>
            <div className="button-row">
              {localFleet && (
                <input
                  className="actor-target-input"
                  type="text"
                  value={targetInput}
                  onChange={(event) => setTargetInput(event.target.value)}
                  placeholder="Target (name, domain, id…)"
                  aria-label="Actor target"
                  title="What this local actor should run against (e.g. a person name, domain, or id)"
                />
              )}
              {selectedActor && (
                <button
                  className="button small"
                  type="button"
                  disabled={!canRunSelected}
                  title={
                    localFleet
                      ? targetInput.trim()
                        ? "Run this actor locally on this machine via the control-plane python checkout"
                        : "Enter a target (name, domain, id…) to run this local actor"
                      : serverManaged
                        ? "Registry entries are selectable for inspection; execution remains server-owned"
                        : !selectedIds.length
                          ? "Select one or more graph documents"
                          : builtin
                            ? "Run trusted built-in actor against the current graph selection"
                            : "Run shipped-pack actor against the current graph selection"
                  }
                  onClick={runSelectedActor}
                >
                  <Play size={14} /> Run selected
                </button>
              )}
            </div>
          </div>

          {builtin && actorExecutionBlocked(selectedActor, currentSettings) && (
            <div className="actor-studio-banner actor-gate-banner">
              <span className="actor-gate-badge">Not e2e-verified — disabled</span>
              <p>
                This built-in actor has not been verified end-to-end. It refuses execution until
                experimental actors are enabled.
              </p>
              <button className="button small" type="button" onClick={enableExperimentalActors}>
                Enable experimental actors
              </button>
            </div>
          )}
          {serverManaged && (
            <div className="actor-studio-banner">
              {localFleet ? (
                <>
                  Local registry actor ({selectedActor.actorId}):{" "}
                  {selectedActor.description || "runs on this machine"}. Runs via the control-plane
                  python checkout (starintel-pro-actors) — not in the browser. Give it a target
                  above and press Run. The manifest is read-only.
                </>
              ) : (
                <>
                  Registry-managed {selectedActor.resourceKind}: {selectedActor.status} ·{" "}
                  {selectedActor.ready ? "ready" : "not ready"} · {selectedActor.sourcePackage}.
                  Registry entries are read-only in Quasar.
                </>
              )}
            </div>
          )}

          {serverManaged && (
            <ServerActorTarget actor={selectedActor} configuration={currentSettings} />
          )}

          <nav className="actor-editor-tabs" aria-label="Actor editor">
            {["config", "runtime"].map((tab) => (
              <button
                type="button"
                key={tab}
                className={editorTab === tab ? "active" : ""}
                onClick={() => setEditorTab(tab)}
              >
                {tab === "config" && <Settings2 size={15} />}
                {tab}
              </button>
            ))}
          </nav>

          {editorTab === "config" && (
            <div className="actor-config-editor">
              <div className="actor-config-toolbar">
                <span>{serverManaged ? "Actor registry entry JSON" : "Actor manifest JSON"}</span>
              </div>
              <CodeEditor
                value={draft.config}
                readOnly
                language="json"
                ariaLabel={serverManaged ? "Actor registry entry JSON" : "Actor manifest JSON"}
                onChange={(config) => setDraft((current) => ({ ...current, config }))}
              />
            </div>
          )}

          {editorTab === "runtime" && (
            <div className="actor-runtime-config">
              <div className="actor-security-note">
                <Settings2 size={20} />
                <div>
                  <strong>Execution model</strong>
                  <p>
                    Built-in and shipped-pack actors run in the browser against the current graph
                    selection. Local fleet actors run on this machine through the control-plane
                    python checkout. Server registry entries stay outside the browser entirely.
                  </p>
                </div>
              </div>
              <dl className="actor-runtime-details">
                <dt>Selected documents</dt>
                <dd>{selectedIds.length}</dd>
                <dt>Actors</dt>
                <dd>{actors.length}</dd>
                <dt>StarIntel server actors</dt>
                <dd>{serverActors.length}</dd>
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
