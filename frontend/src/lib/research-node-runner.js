import {
  normalizeResearchNode,
  researchNodeExecutionPlan,
  transitionResearchNode
} from "./research-nodes";

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function aborted(error) {
  return error?.name === "AbortError";
}

function actorMetric(result, snake, camel = snake) {
  const value = result?.metrics?.[snake] ?? result?.metrics?.[camel] ?? 0;
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : 0;
}

function outputIds(result) {
  return unique((result?.documents || []).map((document) => document?._id));
}

function newOutputIds(result) {
  return unique(result?.newDocumentIds || outputIds(result));
}

function terminalLimitReason(data) {
  const { counters, limits } = data;
  if (counters.actor_runs >= limits.max_actor_runs) return "Actor run limit reached.";
  if (counters.requests >= limits.max_requests) return "Request limit reached.";
  if (counters.elapsed_ms >= limits.max_elapsed_ms) return "Elapsed-time limit reached.";
  if (limits.max_cost > 0 && counters.cost >= limits.max_cost) return "Cost limit reached.";
  if (counters.repeated_state >= limits.max_repeated_state) return "Repeated-state limit reached.";
  return "";
}

export function createResearchNodeRunner({
  resolveActor,
  resolveDocument,
  runActor,
  saveNode,
  onStatus = () => {},
  now = () => Date.now(),
  createRunId = () =>
    `run:research:${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`
}) {
  if (typeof resolveActor !== "function") throw new TypeError("resolveActor is required");
  if (typeof resolveDocument !== "function") throw new TypeError("resolveDocument is required");
  if (typeof runActor !== "function") throw new TypeError("runActor is required");
  if (typeof saveNode !== "function") throw new TypeError("saveNode is required");

  const active = new Map();
  const stamp = () => new Date(now()).toISOString();

  async function persist(document, label) {
    const normalized = normalizeResearchNode(document);
    await saveNode(normalized, label);
    onStatus({
      id: normalized._id,
      state: normalized.data.status,
      actorId: normalized.data.current_actor_id,
      runId: normalized.data.current_run_id
    });
    return normalized;
  }

  async function move(document, state, options = {}) {
    return persist(
      transitionResearchNode(document, state, { at: stamp(), ...options }),
      `Research node ${state}: ${document._id}`
    );
  }

  async function settleRequested(document, record) {
    if (record.requested === "paused") {
      return move(document, "paused", {
        pausedReason: record.reason || "Paused by operator",
        message: record.reason || "Paused by operator"
      });
    }
    if (record.requested === "killed") {
      return move(document, "killed", {
        message: record.reason || "Killed by operator"
      });
    }
    return document;
  }

  function start(document, mode = "run") {
    const normalized = normalizeResearchNode(document);
    if (active.has(normalized._id)) {
      throw new Error(`Research node is already active: ${normalized._id}`);
    }
    const record = {
      controller: new AbortController(),
      requested: "running",
      reason: "",
      promise: null
    };
    active.set(normalized._id, record);
    onStatus({ id: normalized._id, state: "queued", actorId: "", runId: "" });
    record.promise = execute(normalized, mode, record).finally(() => active.delete(normalized._id));
    return record.promise;
  }

  async function execute(initial, mode, record) {
    let node = initial;
    const plan = researchNodeExecutionPlan(node);
    const startedAt = now();
    const restart = mode === "run" && ["completed", "killed"].includes(node.data.status);
    const baseCounters = restart
      ? { depth: 0, actor_runs: 0, requests: 0, repeated_state: 0, elapsed_ms: 0, cost: 0 }
      : node.data.counters;
    const elapsed = () => baseCounters.elapsed_ms + Math.max(0, now() - startedAt);
    const resumable = ["paused", "blocked", "failed"].includes(node.data.status);
    const currentIndex =
      resumable && node.data.current_actor_id
        ? plan.actorIds.indexOf(node.data.current_actor_id)
        : -1;
    let actorIndex = mode === "run" ? 0 : Math.max(0, currentIndex);
    let selection = unique([...plan.inputIds, ...plan.targetIds, ...node.data.output_ids])
      .map((id) => resolveDocument(id))
      .filter(Boolean);
    let successfulRuns = 0;
    let failedRuns = 0;

    try {
      if (!["queued", "running"].includes(node.data.status)) {
        node = await move(node, "queued", {
          message: mode === "run" ? "Queued by operator" : `${mode} requested`,
          error: "",
          pausedReason: "",
          counters: baseCounters
        });
      }
      node = await move(node, "running", {
        message: mode === "run" ? "Research execution started" : `Research ${mode} started`,
        error: "",
        pausedReason: ""
      });

      if (record.requested !== "running") return settleRequested(node, record);

      const blockedDependency = plan.dependencyIds
        ?.map((id) => resolveDocument(id))
        .find((dependency) => dependency?.data?.status !== "completed");
      const missingDependency = plan.dependencyIds?.find((id) => !resolveDocument(id));
      if (missingDependency || blockedDependency) {
        const dependencyId = missingDependency || blockedDependency._id;
        return move(node, "blocked", {
          message: `Waiting for dependency ${dependencyId}`,
          error: `Dependency is not completed: ${dependencyId}`
        });
      }

      if (!plan.actorIds.length) {
        return move(node, plan.stop.when_actor_queue_empty ? "completed" : "blocked", {
          message: plan.stop.when_actor_queue_empty
            ? "Actor queue is empty."
            : "Actor queue is empty and the queue-empty stop rule is disabled."
        });
      }

      for (; actorIndex < plan.actorIds.length; actorIndex += 1) {
        if (record.requested !== "running") return settleRequested(node, record);

        const elapsedBeforeRun = elapsed();
        node.data.counters.elapsed_ms = elapsedBeforeRun;
        const limitReason = terminalLimitReason(node.data);
        if (limitReason) {
          return move(node, "blocked", { message: limitReason, error: limitReason });
        }

        const actorId = plan.actorIds[actorIndex];
        const actor = resolveActor(actorId);
        if (!actor) {
          return move(node, "blocked", {
            currentActorId: actorId,
            message: `Actor is unavailable: ${actorId}`,
            error: `Actor is unavailable: ${actorId}`
          });
        }

        const runId = createRunId(node, actor, actorIndex);
        node = await move(node, "running", {
          currentActorId: actorId,
          currentRunId: runId,
          runIds: [runId],
          counters: {
            ...node.data.counters,
            actor_runs: node.data.counters.actor_runs + 1,
            elapsed_ms: elapsed()
          },
          message: `Running ${actor.label || actor.id}`
        });

        try {
          const result = await runActor(actor, selection, {
            signal: record.controller.signal,
            quiet: true,
            researchNodeId: node._id,
            runId
          });
          if (record.requested !== "running") return settleRequested(node, record);

          const outputs = outputIds(result);
          const newOutputs = newOutputIds(result);
          const requests = actorMetric(result, "requests");
          const cost = actorMetric(result, "cost");
          const repeated = newOutputs.length ? 0 : node.data.counters.repeated_state + 1;
          successfulRuns += 1;
          node = await move(node, "running", {
            currentActorId: actorId,
            currentRunId: runId,
            outputIds: outputs,
            artifactIds: unique((result?.artifacts || []).map((artifact) => artifact?.id)),
            counters: {
              ...node.data.counters,
              requests: node.data.counters.requests + requests,
              cost: node.data.counters.cost + cost,
              repeated_state: repeated,
              elapsed_ms: elapsed()
            },
            message: result?.message || `${actor.label || actor.id} completed`,
            error: ""
          });

          const nextSelection = (result?.documents || [])
            .filter((document) => document?.dtype !== "relation")
            .filter((document) => document?._id);
          if (nextSelection.length) selection = nextSelection;

          if (
            plan.stop.when_objective_satisfied &&
            (result?.metrics?.objective_satisfied === true ||
              result?.metrics?.objectiveSatisfied === true)
          ) {
            return move(node, "completed", { message: "Objective satisfied." });
          }
          if (plan.stop.when_no_new_documents && !newOutputs.length) {
            return move(node, "completed", { message: "No new documents were produced." });
          }
          const afterRunLimit = terminalLimitReason(node.data);
          if (afterRunLimit) {
            return move(node, "blocked", { message: afterRunLimit, error: afterRunLimit });
          }
        } catch (error) {
          if (aborted(error) || record.requested !== "running") {
            return settleRequested(node, record);
          }
          failedRuns += 1;
          if (plan.stop.halt_on_actor_failure) {
            return move(node, "failed", {
              currentActorId: actorId,
              currentRunId: runId,
              counters: { ...node.data.counters, elapsed_ms: elapsed() },
              message: `${actor.label || actor.id} failed`,
              error: error.message
            });
          }
          node = await move(node, "running", {
            currentActorId: actorId,
            currentRunId: runId,
            counters: { ...node.data.counters, elapsed_ms: elapsed() },
            message: `${actor.label || actor.id} failed; continuing`,
            error: error.message
          });
        }
      }

      if (!successfulRuns && failedRuns) {
        return move(node, "failed", {
          message: "Every actor run failed.",
          error: node.data.last_error || "Every actor run failed."
        });
      }
      return move(node, plan.stop.when_actor_queue_empty ? "completed" : "blocked", {
        message: plan.stop.when_actor_queue_empty
          ? "Actor queue completed."
          : "Actor queue exhausted without a terminal stop rule."
      });
    } catch (error) {
      if (aborted(error) || record.requested !== "running") {
        return settleRequested(node, record);
      }
      if (node.data.status === "running") {
        return move(node, "failed", {
          message: "Research execution failed.",
          error: error.message
        });
      }
      throw error;
    }
  }

  function request(id, state, reason) {
    const record = active.get(id);
    if (!record) throw new Error(`Research node is not active: ${id}`);
    record.requested = state;
    record.reason = reason;
    record.controller.abort();
    return record.promise;
  }

  return Object.freeze({
    run(document) {
      return start(document, "run");
    },
    resume(document) {
      if (document?.data?.status !== "paused")
        throw new Error("Only paused research nodes can resume.");
      return start(document, "resume");
    },
    retry(document) {
      if (!["failed", "blocked"].includes(document?.data?.status)) {
        throw new Error("Only failed or blocked research nodes can retry.");
      }
      return start(document, "retry");
    },
    pause(id, reason = "Paused by operator") {
      return request(id, "paused", reason);
    },
    kill(id, reason = "Killed by operator") {
      const record = active.get(id);
      if (record) return request(id, "killed", reason);
      const document = resolveDocument(id);
      if (!document) throw new Error(`Research node not found: ${id}`);
      return move(document, "killed", { message: reason });
    },
    isActive(id) {
      return active.has(id);
    },
    dispose() {
      for (const record of active.values()) {
        record.requested = "killed";
        record.reason = "Runner stopped";
        record.controller.abort();
      }
    }
  });
}
