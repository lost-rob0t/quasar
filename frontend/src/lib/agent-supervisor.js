import {
  AGENT_RECORD_TYPES,
  AGENT_STATUSES,
  getAgentRecord,
  listAgentRecords,
  saveAgentRecord
} from "./agent-records";
import { addUsage, budgetState, calculateCost, remainingBudget, zeroUsage } from "./agent-budget";
import { detectAgentLoop, fingerprint } from "./agent-loop-detector";

export const RUN_TRANSITIONS = Object.freeze({
  idle: ["active", "stopped"],
  active: ["paused", "failed", "stopped", "completed", "budget-exhausted"],
  paused: ["active", "stopped"],
  failed: ["active", "stopped"],
  stopped: [],
  completed: ["active"],
  "budget-exhausted": []
});

function stamp() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function summary(value, limit = 4_000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function errorRecord(error) {
  return {
    name: error?.name || "Error",
    code: error?.code || "error",
    message: error?.message || String(error),
    retryable: Boolean(error?.retryable),
    retryAfterMs: error?.retryAfterMs || null
  };
}

function transition(run, status, reason = "") {
  if (!AGENT_STATUSES.includes(status)) throw new TypeError(`Unknown run status: ${status}`);
  if (run.status !== status && !RUN_TRANSITIONS[run.status]?.includes(status)) {
    throw new Error(`Invalid run transition: ${run.status} -> ${status}`);
  }
  return {
    ...run,
    status,
    statusReason: reason,
    updatedAt: stamp(),
    ...(status === "active" && !run.startedAt ? { startedAt: stamp() } : {}),
    ...(["completed", "stopped", "budget-exhausted"].includes(status) ? { endedAt: stamp() } : {})
  };
}

async function delay(milliseconds, signal) {
  if (!milliseconds) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.min(milliseconds, 60_000));
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

export class AgentSupervisor {
  constructor({ adapterFor, toolRegistry, contextFor, pricingFor, stateFingerprint, onUpdate }) {
    this.adapterFor = adapterFor;
    this.toolRegistry = toolRegistry;
    this.contextFor = contextFor;
    this.pricingFor = pricingFor || (() => ({}));
    this.stateFingerprint = stateFingerprint || (() => "");
    this.onUpdate = onUpdate || (() => {});
    this.controllers = new Map();
  }

  async createRun(agent, input = {}) {
    if (!agent.enabled) throw new Error("Agent is disabled");
    const run = await saveAgentRecord(
      {
        id: id("run"),
        recordType: AGENT_RECORD_TYPES.run,
        agentId: agent.id,
        goal: String(input.goal || "").trim(),
        status: "idle",
        statusReason: "",
        providerId: agent.providerId,
        modelId: agent.modelId,
        targetIds: input.targetIds || [],
        selectionIds: input.selectionIds || [],
        dataset: input.dataset || null,
        graphId: input.graphId || null,
        filters: input.filters || {},
        loopEnabled: input.loopEnabled === true,
        messages: input.messages || [],
        history: [],
        usage: zeroUsage(),
        budget: { ...agent.budget },
        pricingSnapshot: { ...this.pricingFor(agent.providerId, agent.modelId) },
        checkpointId: null,
        lastStepId: null
      },
      AGENT_RECORD_TYPES.run
    );
    await this.checkpoint(run, "Run created");
    this.onUpdate(run);
    return run;
  }

  async getRun(runId) {
    return getAgentRecord(AGENT_RECORD_TYPES.run, runId);
  }

  async listRuns(agentId) {
    const runs = await listAgentRecords(AGENT_RECORD_TYPES.run);
    return agentId ? runs.filter((run) => run.agentId === agentId) : runs;
  }

  async persist(run) {
    const saved = await saveAgentRecord(run, AGENT_RECORD_TYPES.run);
    this.onUpdate(saved);
    return saved;
  }

  async setStatus(runId, status, reason = "") {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (status === "paused" || status === "stopped") this.controllers.get(runId)?.abort();
    return this.persist(transition(run, status, reason));
  }

  pause(runId, reason = "Paused by user") {
    return this.setStatus(runId, "paused", reason);
  }

  stop(runId, reason = "Stopped by user") {
    return this.setStatus(runId, "stopped", reason);
  }

  async retry(runId) {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!["failed", "paused", "completed"].includes(run.status))
      throw new Error(`Cannot retry a ${run.status} run`);
    return this.run(run.agent, transition(run, "active", "Retrying"));
  }

  async checkpoint(run, label) {
    const checkpoint = await saveAgentRecord(
      {
        id: id("checkpoint"),
        recordType: AGENT_RECORD_TYPES.checkpoint,
        runId: run.id,
        label,
        status: run.status,
        usage: run.usage,
        messages: run.messages,
        history: run.history,
        stateFingerprint: await this.stateFingerprint(run)
      },
      AGENT_RECORD_TYPES.checkpoint
    );
    run.checkpointId = checkpoint.id;
    await this.persist(run);
    return checkpoint;
  }

  async restoreCheckpoint(runId, checkpointId) {
    const [run, checkpoint] = await Promise.all([
      this.getRun(runId),
      getAgentRecord(AGENT_RECORD_TYPES.checkpoint, checkpointId)
    ]);
    if (!run || !checkpoint || checkpoint.runId !== run.id) throw new Error("Checkpoint not found");
    const restored = {
      ...run,
      status: "paused",
      statusReason: `Restored ${checkpoint.label}`,
      usage: checkpoint.usage,
      messages: checkpoint.messages,
      history: checkpoint.history,
      checkpointId: checkpoint.id
    };
    await saveAgentRecord(
      {
        id: id("recovery"),
        recordType: AGENT_RECORD_TYPES.recoveryEvent,
        runId,
        action: "restore-checkpoint",
        checkpointId
      },
      AGENT_RECORD_TYPES.recoveryEvent
    );
    return this.persist(restored);
  }

  async run(agent, inputOrRun) {
    let run =
      inputOrRun?.recordType === AGENT_RECORD_TYPES.run
        ? inputOrRun
        : await this.createRun(agent, inputOrRun);
    run.agent = agent;
    run = run.status === "active" ? run : transition(run, "active", "");
    run = await this.persist(run);
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    try {
      while (run.status === "active") {
        run = await this.iterate(agent, run, controller.signal);
        if (!run.loopEnabled || run.status !== "active") break;
      }
      if (run.status === "active")
        run = await this.persist(transition(run, "completed", "Run complete"));
      return run;
    } catch (error) {
      if (error?.name === "AbortError") return this.getRun(run.id);
      const failed = transition(run, "failed", error.message);
      failed.lastError = errorRecord(error);
      return this.persist(failed);
    } finally {
      this.controllers.delete(run.id);
    }
  }

  async iterate(agent, run, signal) {
    const started = performance.now();
    const before = budgetState(run.budget, run.usage, { iterations: 1 });
    if (before.state === "hard-stop")
      return this.persist(transition(run, "budget-exhausted", before.reason));
    const context = await this.contextFor(agent, run);
    if (run.pricingSnapshot?.known === false) {
      throw new Error(`Pricing is required before running ${run.modelId}`);
    }
    const remainingOutputTokens = Math.max(
      0,
      Number(run.budget.maxOutputTokens ?? 8_192) - Number(run.usage.outputTokens || 0)
    );
    if (remainingOutputTokens < 1) {
      return this.persist(transition(run, "budget-exhausted", "Output tokens limit reached"));
    }
    const adapter = await this.adapterFor(agent);
    const messages = [
      { role: "system", content: context.systemPrompt },
      ...run.messages,
      ...(run.goal && !run.messages.length ? [{ role: "user", content: run.goal }] : [])
    ];
    let response;
    let attempt = 0;
    while (!response) {
      try {
        response = await adapter.sendMessages({
          model: agent.modelId,
          messages,
          tools: this.toolRegistry.modelDefinitions(agent),
          maxTokens: Math.min(8_192, remainingOutputTokens),
          signal
        });
      } catch (error) {
        attempt += 1;
        if (!error.retryable || attempt > Number(agent.recovery?.retries || 0)) throw error;
        const recovery = {
          id: id("recovery"),
          recordType: AGENT_RECORD_TYPES.recoveryEvent,
          runId: run.id,
          action: "retry-provider",
          attempt,
          error: errorRecord(error)
        };
        await saveAgentRecord(recovery, AGENT_RECORD_TYPES.recoveryEvent);
        await delay(
          error.retryAfterMs || Number(agent.recovery?.backoffMs || 1_000) * 2 ** (attempt - 1),
          signal
        );
      }
    }
    const pricing = run.pricingSnapshot || {};
    const responseCost = calculateCost(response.usage, pricing);
    let usage = addUsage(run.usage, {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cachedTokens: response.usage.cachedTokens,
      costUsd: responseCost,
      iterations: 1
    });
    const modelEntry = {
      id: id("model"),
      kind: "model",
      text: response.text,
      toolCalls: response.toolCalls.map((call) => ({ id: call.id, name: call.name })),
      usage: response.usage,
      costUsd: responseCost,
      at: stamp()
    };
    const history = [...run.history, modelEntry];
    const nextMessages = [
      ...run.messages,
      response.providerMessage || { role: "assistant", content: response.text || "" }
    ];

    for (const call of response.toolCalls.slice(0, 4)) {
      const toolBudget = budgetState(run.budget, usage, { toolCalls: 1 });
      if (toolBudget.state === "hard-stop") {
        run = { ...run, history, messages: nextMessages, usage };
        return this.persist(transition(run, "budget-exhausted", toolBudget.reason));
      }
      let args;
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        args = {};
      }
      const toolStarted = performance.now();
      const toolRecord = {
        id: id("tool"),
        recordType: AGENT_RECORD_TYPES.toolCall,
        runId: run.id,
        agentId: agent.id,
        toolName: call.name,
        arguments: args,
        startedAt: stamp()
      };
      try {
        const result = await this.toolRegistry.execute(call.name, args, {
          agent,
          run,
          selectionIds: run.selectionIds,
          targetIds: run.targetIds,
          dataset: run.dataset,
          graphId: run.graphId
        });
        const completed = {
          ...toolRecord,
          resultSummary: summary(result),
          endedAt: stamp(),
          durationMs: performance.now() - toolStarted,
          costUsd: 0,
          affected: result?.affected || []
        };
        await saveAgentRecord(completed, AGENT_RECORD_TYPES.toolCall);
        history.push({
          id: completed.id,
          kind: "tool",
          name: call.name,
          arguments: args,
          resultSummary: result,
          stateFingerprint: await this.stateFingerprint(run),
          at: completed.endedAt
        });
        nextMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: summary(result)
        });
      } catch (error) {
        const failed = {
          ...toolRecord,
          endedAt: stamp(),
          durationMs: performance.now() - toolStarted,
          costUsd: 0,
          error: errorRecord(error),
          resultSummary: ""
        };
        await saveAgentRecord(failed, AGENT_RECORD_TYPES.toolCall);
        history.push({
          id: failed.id,
          kind: "tool",
          name: call.name,
          arguments: args,
          error: failed.error,
          at: failed.endedAt
        });
        nextMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: failed.error })
        });
        if (error.code === "approval_required") {
          run = { ...run, history, messages: nextMessages, usage };
          return this.persist(transition(run, "paused", error.message));
        }
      }
      usage = addUsage(usage, { toolCalls: 1 });
    }

    usage = addUsage(usage, { runtimeMs: performance.now() - started });
    run = { ...run, history, messages: nextMessages, usage, lastStepId: modelEntry.id };
    const step = await saveAgentRecord(
      {
        id: id("step"),
        recordType: AGENT_RECORD_TYPES.step,
        runId: run.id,
        index: usage.iterations,
        actionSummary:
          response.text ||
          (response.toolCalls.length
            ? `Called ${response.toolCalls.map((call) => call.name).join(", ")}`
            : "No action"),
        toolCallIds: history
          .filter((entry) => entry.kind === "tool")
          .slice(-response.toolCalls.length)
          .map((entry) => entry.id),
        usage,
        stateFingerprint: await this.stateFingerprint(run)
      },
      AGENT_RECORD_TYPES.step
    );
    run.lastStepId = step.id;
    const loop = detectAgentLoop(history, agent.loop);
    if (loop) {
      await saveAgentRecord(
        {
          id: id("loop"),
          recordType: AGENT_RECORD_TYPES.loopEvent,
          runId: run.id,
          ...loop
        },
        AGENT_RECORD_TYPES.loopEvent
      );
      run.loopWarning = loop;
      return this.persist(transition(run, "paused", loop.message));
    }
    const after = budgetState(run.budget, usage);
    if (after.state === "hard-stop")
      return this.persist(transition(run, "budget-exhausted", after.reason));
    run.budgetWarning = after.state === "warning" ? after.reason : "";
    run.remainingBudget = remainingBudget(run.budget, usage);
    await saveAgentRecord(
      {
        id: id("cost"),
        recordType: AGENT_RECORD_TYPES.cost,
        runId: run.id,
        agentId: agent.id,
        providerId: run.providerId,
        modelId: run.modelId,
        usage: response.usage,
        costUsd: responseCost,
        exactUsage: response.usage.exact,
        pricingSnapshot: run.pricingSnapshot
      },
      AGENT_RECORD_TYPES.cost
    );
    await this.checkpoint(run, `Iteration ${usage.iterations}`);
    if (!response.toolCalls.length)
      return this.persist(transition(run, "completed", "Run complete"));
    return this.persist(run);
  }

  async restoreInterruptedRuns() {
    const runs = await this.listRuns();
    const restored = [];
    for (const run of runs.filter((candidate) => candidate.status === "active")) {
      restored.push(
        await this.persist(transition(run, "paused", "Browser reloaded; resume from checkpoint"))
      );
    }
    return restored;
  }
}

export function runStateFingerprint(documents, graph) {
  return fingerprint({
    documents: documents.map((document) => [
      document._id,
      document._rev || document.version,
      document.date_updated
    ]),
    graph: graph ? [graph.id, graph.documentIds, graph.positions] : null
  });
}
