import { useState } from "react";
import { ExternalLink, Pause, Play, RotateCcw, Save, Square } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { touchDocument } from "starintel_doc";
import { operation } from "../../lib/operations";
import { createResearchNode, normalizeResearchNode } from "../../lib/research-nodes";
import { useQuasar } from "../../store";
import { GraphModalShell } from "./shared";

export function parseResearchNodeIds(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function formatIds(values) {
  return (values || []).join("\n");
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export default function CompactResearchNodeEditor({
  document = null,
  dataset = "default",
  inputIds = [],
  position = null,
  onClose,
  onSaved
}) {
  const navigate = useNavigate();
  const {
    actors = [],
    execute,
    setNotice,
    addDocumentsToActiveGraph,
    workspace,
    researchRunState = {},
    runResearchNode,
    pauseResearchNode,
    resumeResearchNode,
    retryResearchNode,
    killResearchNode
  } = useQuasar();
  const data = document?.data || {};
  const limits = data.limits || {};
  const stop = data.stop || {};
  const [objective, setObjective] = useState(data.objective || "");
  const [instructions, setInstructions] = useState(data.instructions || "");
  const [inputs, setInputs] = useState(
    formatIds(data.input_ids?.length ? data.input_ids : inputIds)
  );
  const [targets, setTargets] = useState(formatIds(data.target_ids));
  const [actorIds, setActorIds] = useState(formatIds(data.actor_ids));
  const [maxDepth, setMaxDepth] = useState(limits.max_depth ?? 4);
  const [maxActorRuns, setMaxActorRuns] = useState(limits.max_actor_runs ?? 64);
  const [maxRequests, setMaxRequests] = useState(limits.max_requests ?? 1024);
  const [maxMinutes, setMaxMinutes] = useState(
    Math.max(1, Math.round((limits.max_elapsed_ms ?? 1800000) / 60000))
  );
  const [maxRepeatedState, setMaxRepeatedState] = useState(limits.max_repeated_state ?? 3);
  const [maxCost, setMaxCost] = useState(limits.max_cost ?? 0);
  const [stopWhenQueueEmpty, setStopWhenQueueEmpty] = useState(stop.when_actor_queue_empty ?? true);
  const [stopWhenNoNewDocuments, setStopWhenNoNewDocuments] = useState(
    stop.when_no_new_documents ?? true
  );
  const [stopWhenSatisfied, setStopWhenSatisfied] = useState(
    stop.when_objective_satisfied ?? false
  );
  const [haltOnFailure, setHaltOnFailure] = useState(stop.halt_on_actor_failure ?? false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const status = document?.data?.status || "draft";
  const active = ["queued", "running"].includes(researchRunState[document?._id]?.state);

  function change(setter) {
    return (event) => {
      setter(event.target.type === "checkbox" ? event.target.checked : event.target.value);
      setDirty(true);
    };
  }

  function planData() {
    return {
      objective: objective.trim(),
      instructions: instructions.trim(),
      inputIds: parseResearchNodeIds(inputs),
      targetIds: parseResearchNodeIds(targets),
      actorIds: parseResearchNodeIds(actorIds),
      limits: {
        max_depth: numberValue(maxDepth, 4),
        max_actor_runs: numberValue(maxActorRuns, 64),
        max_requests: numberValue(maxRequests, 1024),
        max_elapsed_ms: numberValue(maxMinutes, 30) * 60000,
        max_repeated_state: numberValue(maxRepeatedState, 3),
        max_cost: numberValue(maxCost, 0),
        currency: limits.currency || "USD"
      },
      stop: {
        when_actor_queue_empty: stopWhenQueueEmpty,
        when_no_new_documents: stopWhenNoNewDocuments,
        when_objective_satisfied: stopWhenSatisfied,
        halt_on_actor_failure: haltOnFailure
      }
    };
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const plan = planData();
      if (!plan.objective) throw new Error("Research objective is required.");
      let next;
      if (document) {
        next = normalizeResearchNode(
          touchDocument(document, {
            title: document.title || plan.objective,
            summary: plan.objective,
            data: {
              ...document.data,
              objective: plan.objective,
              instructions: plan.instructions,
              input_ids: plan.inputIds,
              target_ids: plan.targetIds,
              actor_ids: plan.actorIds,
              limits: plan.limits,
              stop: plan.stop
            }
          })
        );
      } else {
        const suffix =
          globalThis.crypto?.randomUUID?.() ||
          `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        next = createResearchNode({
          id: `starintel:research-node:${suffix}`,
          dataset,
          title: plan.objective,
          ...plan
        });
      }

      await execute(operation.save(next), `${document ? "Update" : "Create"} ${next._id}`);
      if (!document) {
        const changes = { selectedIds: [next._id] };
        if (position?.position) {
          changes.positions = {
            ...(workspace?.positions || {}),
            [next._id]: position.position
          };
        }
        addDocumentsToActiveGraph([next._id], changes);
      }
      setDirty(false);
      onSaved?.(next);
      onClose();
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    } finally {
      setSaving(false);
    }
  }

  function control(action) {
    const actions = {
      run: runResearchNode,
      pause: pauseResearchNode,
      resume: resumeResearchNode,
      retry: retryResearchNode,
      kill: killResearchNode
    };
    try {
      const pending = actions[action](document);
      onClose();
      Promise.resolve(pending).catch((error) =>
        setNotice({ kind: "error", message: error.message })
      );
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  return (
    <GraphModalShell
      title={document ? "Edit research node" : "New research node"}
      position={position}
      onClose={onClose}
      dirty={dirty}
      className="graph-research-node-editor"
    >
      {(requestClose) => (
        <form className="graph-compact-form" onSubmit={submit}>
          <div className="graph-editor-type-heading">
            <strong>Research plan</strong>
            <span>
              {document?.data?.status || "draft"} · {document?.dataset || dataset}
            </span>
          </div>

          <label className="field full">
            <span>Objective</span>
            <small>required · concise description of what this node must establish</small>
            <textarea
              value={objective}
              onChange={change(setObjective)}
              rows="2"
              autoFocus
              required
            />
          </label>

          <label className="field full">
            <span>Operator instructions</span>
            <small>optional · constraints, method, and expected evidence</small>
            <textarea value={instructions} onChange={change(setInstructions)} rows="3" />
          </label>

          <div className="graph-editor-fields">
            <label className="field">
              <span>Input document IDs</span>
              <small>one per line or comma-separated</small>
              <textarea value={inputs} onChange={change(setInputs)} rows="4" />
            </label>
            <label className="field">
              <span>Target document IDs</span>
              <small>one per line or comma-separated</small>
              <textarea value={targets} onChange={change(setTargets)} rows="4" />
            </label>
            <label className="field full">
              <span>Actor IDs</span>
              <small>ordered · one per line or comma-separated</small>
              <textarea
                value={actorIds}
                onChange={change(setActorIds)}
                rows="3"
                list="research-node-actors"
              />
              <datalist id="research-node-actors">
                {actors.map((actor) => (
                  <option key={actor.id} value={actor.id}>
                    {actor.label || actor.id}
                  </option>
                ))}
              </datalist>
            </label>
          </div>

          <fieldset className="research-node-limits">
            <legend>Limits</legend>
            <label>
              <span>Depth</span>
              <input type="number" min="1" value={maxDepth} onChange={change(setMaxDepth)} />
            </label>
            <label>
              <span>Actor runs</span>
              <input
                type="number"
                min="1"
                value={maxActorRuns}
                onChange={change(setMaxActorRuns)}
              />
            </label>
            <label>
              <span>Requests</span>
              <input type="number" min="1" value={maxRequests} onChange={change(setMaxRequests)} />
            </label>
            <label>
              <span>Minutes</span>
              <input type="number" min="1" value={maxMinutes} onChange={change(setMaxMinutes)} />
            </label>
            <label>
              <span>Repeat limit</span>
              <input
                type="number"
                min="1"
                value={maxRepeatedState}
                onChange={change(setMaxRepeatedState)}
              />
            </label>
            <label>
              <span>Max cost</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={maxCost}
                onChange={change(setMaxCost)}
              />
            </label>
          </fieldset>

          <fieldset className="research-node-stop-rules">
            <legend>Stop rules</legend>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={stopWhenQueueEmpty}
                onChange={change(setStopWhenQueueEmpty)}
              />{" "}
              Actor queue is empty
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={stopWhenNoNewDocuments}
                onChange={change(setStopWhenNoNewDocuments)}
              />{" "}
              No new documents
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={stopWhenSatisfied}
                onChange={change(setStopWhenSatisfied)}
              />{" "}
              Objective is satisfied
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={haltOnFailure} onChange={change(setHaltOnFailure)} />{" "}
              Actor failure
            </label>
          </fieldset>

          <div className="graph-editor-secondary-actions">
            {document && (
              <>
                {!active &&
                  ["draft", "queued", "running", "completed", "killed"].includes(status) && (
                    <button className="button small" type="button" onClick={() => control("run")}>
                      <Play size={14} />{" "}
                      {["queued", "running"].includes(status) ? "Continue" : "Run"}
                    </button>
                  )}
                {active && (
                  <button className="button small" type="button" onClick={() => control("pause")}>
                    <Pause size={14} /> Pause
                  </button>
                )}
                {status === "paused" && (
                  <button className="button small" type="button" onClick={() => control("resume")}>
                    <Play size={14} /> Resume
                  </button>
                )}
                {["failed", "blocked"].includes(status) && (
                  <button className="button small" type="button" onClick={() => control("retry")}>
                    <RotateCcw size={14} /> Retry
                  </button>
                )}
                {["queued", "running", "paused", "blocked", "failed"].includes(status) && (
                  <button
                    className="button small danger"
                    type="button"
                    onClick={() => control("kill")}
                  >
                    <Square size={14} /> Kill
                  </button>
                )}
                <button
                  className="button small"
                  type="button"
                  onClick={() =>
                    navigate(
                      `/documents/${encodeURIComponent(document._id)}/edit?advanced=1&returnTo=graph`
                    )
                  }
                >
                  <ExternalLink size={14} /> Open full editor
                </button>
              </>
            )}
            {!document && <small>Save the plan to unlock run controls.</small>}
          </div>

          <div className="form-actions graph-editor-actions">
            <span />
            <span />
            <button className="button" type="button" onClick={requestClose}>
              Cancel
            </button>
            <button className="button primary" disabled={saving}>
              <Save size={14} /> {saving ? "Saving…" : "Save plan"}
            </button>
          </div>
        </form>
      )}
    </GraphModalShell>
  );
}
