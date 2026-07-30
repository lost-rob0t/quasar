import { assertDocument } from "starintel_doc";

export const RESEARCH_NODE_DTYPE = "research-node";
export const RESEARCH_NODE_STATES = Object.freeze([
  "draft",
  "queued",
  "running",
  "paused",
  "blocked",
  "completed",
  "failed",
  "killed"
]);

const STATE_SET = new Set(RESEARCH_NODE_STATES);
const TRANSITIONS = Object.freeze({
  draft: new Set(["queued", "running", "killed"]),
  queued: new Set(["running", "paused", "killed"]),
  running: new Set(["paused", "blocked", "completed", "failed", "killed"]),
  paused: new Set(["queued", "running", "killed"]),
  blocked: new Set(["queued", "running", "failed", "killed"]),
  completed: new Set(["queued", "running"]),
  failed: new Set(["queued", "running", "killed"]),
  killed: new Set(["queued", "running"])
});

const DEFAULT_LIMITS = Object.freeze({
  max_depth: 4,
  max_actor_runs: 64,
  max_requests: 1_024,
  max_elapsed_ms: 30 * 60 * 1_000,
  max_repeated_state: 3,
  max_cost: 0,
  currency: "USD"
});

const DEFAULT_STOP = Object.freeze({
  when_actor_queue_empty: true,
  when_no_new_documents: true,
  when_objective_satisfied: false,
  halt_on_actor_failure: false
});

const DEFAULT_COUNTERS = Object.freeze({
  depth: 0,
  actor_runs: 0,
  requests: 0,
  repeated_state: 0,
  elapsed_ms: 0,
  cost: 0
});

function cloneValue(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function stringList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("Research node ID lists must be arrays");
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function objectList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item) => cloneValue(objectValue(item, `${label} entry`)));
}

function integer(value, fallback, minimum, label) {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(normalized) || normalized < minimum) {
    throw new TypeError(`${label} must be an integer of at least ${minimum}`);
  }
  return normalized;
}

function number(value, fallback, minimum, label) {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(normalized) || normalized < minimum) {
    throw new TypeError(`${label} must be a number of at least ${minimum}`);
  }
  return normalized;
}

function state(value) {
  const normalized = String(value || "draft").trim();
  if (!STATE_SET.has(normalized))
    throw new TypeError(`Unsupported research node state: ${normalized}`);
  return normalized;
}

function field(value, camel, snake) {
  return value?.[snake] ?? value?.[camel];
}

function normalizeLimits(value = {}, fallback = DEFAULT_LIMITS) {
  objectValue(value, "Research node limits");
  return {
    max_depth: integer(
      field(value, "maxDepth", "max_depth"),
      fallback.max_depth,
      1,
      "Research node max_depth"
    ),
    max_actor_runs: integer(
      field(value, "maxActorRuns", "max_actor_runs"),
      fallback.max_actor_runs,
      1,
      "Research node max_actor_runs"
    ),
    max_requests: integer(
      field(value, "maxRequests", "max_requests"),
      fallback.max_requests,
      1,
      "Research node max_requests"
    ),
    max_elapsed_ms: integer(
      field(value, "maxElapsedMs", "max_elapsed_ms"),
      fallback.max_elapsed_ms,
      1,
      "Research node max_elapsed_ms"
    ),
    max_repeated_state: integer(
      field(value, "maxRepeatedState", "max_repeated_state"),
      fallback.max_repeated_state,
      1,
      "Research node max_repeated_state"
    ),
    max_cost: number(
      field(value, "maxCost", "max_cost"),
      fallback.max_cost,
      0,
      "Research node max_cost"
    ),
    currency: String(value.currency ?? fallback.currency ?? "USD").trim()
  };
}

function normalizeStop(value = {}, fallback = DEFAULT_STOP) {
  objectValue(value, "Research node stop conditions");
  return {
    when_actor_queue_empty:
      field(value, "whenActorQueueEmpty", "when_actor_queue_empty") ??
      fallback.when_actor_queue_empty,
    when_no_new_documents:
      field(value, "whenNoNewDocuments", "when_no_new_documents") ?? fallback.when_no_new_documents,
    when_objective_satisfied:
      field(value, "whenObjectiveSatisfied", "when_objective_satisfied") ??
      fallback.when_objective_satisfied,
    halt_on_actor_failure:
      field(value, "haltOnActorFailure", "halt_on_actor_failure") ?? fallback.halt_on_actor_failure
  };
}

function normalizeCounters(value = {}, fallback = DEFAULT_COUNTERS) {
  objectValue(value, "Research node counters");
  return {
    depth: integer(value.depth, fallback.depth, 0, "Research node depth"),
    actor_runs: integer(
      field(value, "actorRuns", "actor_runs"),
      fallback.actor_runs,
      0,
      "Research node actor_runs"
    ),
    requests: integer(value.requests, fallback.requests, 0, "Research node requests"),
    repeated_state: integer(
      field(value, "repeatedState", "repeated_state"),
      fallback.repeated_state,
      0,
      "Research node repeated_state"
    ),
    elapsed_ms: integer(
      field(value, "elapsedMs", "elapsed_ms"),
      fallback.elapsed_ms,
      0,
      "Research node elapsed_ms"
    ),
    cost: number(value.cost, fallback.cost, 0, "Research node cost")
  };
}

function normalizeHistoryEntry(value) {
  objectValue(value, "Research node history entry");
  const from =
    value.from === null || value.from === undefined || value.from === "" ? null : state(value.from);
  return {
    from,
    to: state(value.to),
    at: String(value.at || "").trim(),
    message: String(value.message || "").trim(),
    error: String(value.error || "").trim(),
    actor_id: String(field(value, "actorId", "actor_id") || "").trim(),
    run_id: String(field(value, "runId", "run_id") || "").trim(),
    output_ids: stringList(field(value, "outputIds", "output_ids")),
    artifact_ids: stringList(field(value, "artifactIds", "artifact_ids"))
  };
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) throw new TypeError("Research node history must be an array");
  return value.slice(-128).map(normalizeHistoryEntry);
}

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function normalizeData(value) {
  const data = objectValue(value, "Research node data");
  const objective = String(data.objective || "").trim();
  if (!objective) throw new TypeError("Research node objective is required");
  const status = state(data.status);
  const createdAt = nullableTimestamp(data.created_at) || new Date().toISOString();
  const history =
    Array.isArray(data.history) && data.history.length
      ? normalizeHistory(data.history)
      : [
          normalizeHistoryEntry({
            from: null,
            to: status,
            at: createdAt,
            message: "Research node created"
          })
        ];

  return {
    objective,
    instructions: String(data.instructions || "").trim(),
    status,
    input_ids: stringList(data.input_ids),
    target_ids: stringList(data.target_ids),
    actor_ids: stringList(data.actor_ids),
    actor_selection_rules: objectList(
      data.actor_selection_rules,
      "Research node actor selection rules"
    ),
    output_ids: stringList(data.output_ids),
    artifact_ids: stringList(data.artifact_ids),
    child_ids: stringList(data.child_ids),
    dependency_ids: stringList(data.dependency_ids),
    run_ids: stringList(data.run_ids),
    current_actor_id: String(data.current_actor_id || "").trim(),
    current_run_id: String(data.current_run_id || "").trim(),
    limits: normalizeLimits(data.limits || {}),
    stop: normalizeStop(data.stop || {}),
    counters: normalizeCounters(data.counters || {}),
    history,
    created_at: createdAt,
    started_at: nullableTimestamp(data.started_at),
    completed_at: nullableTimestamp(data.completed_at),
    last_error: String(data.last_error || "").trim(),
    paused_reason: String(data.paused_reason || "").trim()
  };
}

export function isResearchNode(document) {
  return document?.dtype === RESEARCH_NODE_DTYPE;
}

export function createResearchNode(input = {}) {
  const id = String(input.id || "").trim();
  const objective = String(input.objective || "").trim();
  const title = String(input.title || objective || "Research node").trim();
  const createdAt = String(input.createdAt || new Date().toISOString());
  const initialState = state(input.status || "draft");
  if (!id) throw new TypeError("Research node id is required");
  if (!objective) throw new TypeError("Research node objective is required");

  const data = normalizeData({
    objective,
    instructions: input.instructions,
    status: initialState,
    input_ids: input.inputIds,
    target_ids: input.targetIds,
    actor_ids: input.actorIds,
    actor_selection_rules: input.actorSelectionRules,
    output_ids: input.outputIds,
    artifact_ids: input.artifactIds,
    child_ids: input.childIds,
    dependency_ids: input.dependencyIds,
    run_ids: input.runIds,
    current_actor_id: input.currentActorId,
    current_run_id: input.currentRunId,
    limits: input.limits || {},
    stop: input.stop || {},
    counters: input.counters || {},
    history: input.history || [
      { from: null, to: initialState, at: createdAt, message: "Research node created" }
    ],
    created_at: createdAt,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    last_error: input.lastError,
    paused_reason: input.pausedReason
  });

  return assertDocument({
    _id: id,
    dataset: String(input.dataset || "default"),
    dtype: RESEARCH_NODE_DTYPE,
    schema_version: String(input.schemaVersion || "0.9.0"),
    version: 1,
    date_added: createdAt,
    date_updated: createdAt,
    title,
    summary: objective,
    status: initialState,
    sources: [],
    evidence: [],
    data
  });
}

export function normalizeResearchNode(document) {
  if (!isResearchNode(document)) throw new TypeError("Document is not a research node");
  const normalized = cloneValue(assertDocument(document));
  normalized.data = normalizeData(normalized.data);
  normalized.summary = normalized.data.objective;
  normalized.status = normalized.data.status;
  return assertDocument(normalized);
}

export function transitionResearchNode(document, nextState, options = {}) {
  const normalized = normalizeResearchNode(document);
  const data = normalized.data;
  const from = data.status;
  const to = state(nextState);
  if (from !== to && !TRANSITIONS[from].has(to)) {
    throw new Error(`Invalid research node transition: ${from} -> ${to}`);
  }

  const at = String(options.at || new Date().toISOString());
  const outputIds = stringList(options.outputIds);
  const artifactIds = stringList(options.artifactIds);
  const childIds = stringList(options.childIds);
  const runIds = stringList(options.runIds);
  data.status = to;
  data.current_actor_id = String(options.currentActorId ?? data.current_actor_id ?? "").trim();
  data.current_run_id = String(options.currentRunId ?? data.current_run_id ?? "").trim();
  data.output_ids = stringList([...(data.output_ids || []), ...outputIds]);
  data.artifact_ids = stringList([...(data.artifact_ids || []), ...artifactIds]);
  data.child_ids = stringList([...(data.child_ids || []), ...childIds]);
  data.run_ids = stringList([...(data.run_ids || []), ...runIds, data.current_run_id]);
  data.counters = normalizeCounters(options.counters || {}, data.counters);
  data.last_error =
    options.error === undefined ? data.last_error : String(options.error || "").trim();
  data.paused_reason =
    options.pausedReason === undefined
      ? data.paused_reason
      : String(options.pausedReason || "").trim();
  if (["queued", "running"].includes(to)) data.completed_at = null;
  if (to === "running" && !data.started_at) data.started_at = at;
  if (["completed", "failed", "killed"].includes(to)) data.completed_at = at;
  data.history = normalizeHistory([
    ...(data.history || []),
    {
      from,
      to,
      at,
      message: String(options.message || "").trim(),
      error: String(options.error || "").trim(),
      actor_id: data.current_actor_id,
      run_id: data.current_run_id,
      output_ids: outputIds,
      artifact_ids: artifactIds
    }
  ]);

  normalized.version = Number(normalized.version || 0) + 1;
  normalized.date_updated = at;
  normalized.status = to;
  normalized.summary = data.objective;
  normalized.data = data;
  return assertDocument(normalized);
}

export function researchNodeExecutionPlan(document) {
  const normalized = normalizeResearchNode(document);
  const data = normalized.data;
  return {
    researchNodeId: normalized._id,
    objective: data.objective,
    instructions: data.instructions,
    inputIds: [...data.input_ids],
    targetIds: [...data.target_ids],
    actorIds: [...data.actor_ids],
    actorSelectionRules: cloneValue(data.actor_selection_rules),
    dependencyIds: [...data.dependency_ids],
    limits: cloneValue(data.limits),
    stop: cloneValue(data.stop)
  };
}
