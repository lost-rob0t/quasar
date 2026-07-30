import { getState, putState, stateDb } from "./db";

export const AGENT_SCHEMA_VERSION = 1;
export const AGENT_PACK_FORMAT = "quasar-agent-pack";
export const AGENT_PACK_VERSION = 1;
const DEFAULT_PERMISSION_PROFILE_VERSION = 2;
const DEFAULT_PERMISSION_UPGRADES = Object.freeze({
  researcher: ["graph.edit"],
  "graph-analyst": ["sources.external"]
});
export const AGENT_RECORD_TYPES = Object.freeze({
  agent: "quasar.agent",
  role: "quasar.agent-role",
  run: "quasar.agent-run",
  step: "quasar.agent-run-step",
  checkpoint: "quasar.agent-checkpoint",
  provider: "quasar.provider-config",
  model: "quasar.model-config",
  budget: "quasar.budget-policy",
  cost: "quasar.cost-record",
  toolCall: "quasar.tool-call",
  loopEvent: "quasar.loop-event",
  recoveryEvent: "quasar.recovery-event",
  memory: "quasar.agent-memory",
  generatedActor: "quasar.agent-generated-actor",
  skill: "quasar.agent-skill",
  mcpServer: "quasar.mcp-server"
});

export const AGENT_STATUSES = Object.freeze([
  "idle",
  "active",
  "paused",
  "failed",
  "stopped",
  "completed",
  "budget-exhausted"
]);

export const AGENT_PERMISSIONS = Object.freeze([
  "documents.read",
  "documents.create",
  "documents.edit",
  "documents.delete",
  "graph.read",
  "graph.edit",
  "actors.run",
  "actors.create",
  "actors.edit",
  "actors.delete",
  "targets.read",
  "targets.edit",
  "sources.external",
  "data.import",
  "data.export",
  "targets.submit",
  "queues.read",
  "queues.write",
  "server.use",
  "destructive"
]);

export const DEFAULT_ROLES = Object.freeze([
  {
    id: "researcher",
    name: "Researcher",
    instructions:
      "Investigate the scoped target. Separate sourced facts, claims, inference, hypotheses, user conclusions, and unverified leads. Preserve provenance.",
    permissions: [
      "documents.read",
      "documents.create",
      "documents.edit",
      "graph.read",
      "graph.edit",
      "targets.read",
      "sources.external",
      "actors.run"
    ],
    actions: ["inspect", "research", "create", "relate", "verify"],
    accepts: ["*"],
    outputs: ["source", "claim", "relation", "person", "org", "event", "location"],
    autonomy: "bounded",
    review: "mutations",
    retry: { maxAttempts: 3, backoffMs: 1_000 },
    budget: { maxCostUsd: 2, maxIterations: 20, maxToolCalls: 60, maxRuntimeMs: 900_000 }
  },
  {
    id: "graph-analyst",
    name: "Graph analyst",
    instructions:
      "Inspect graph structure and propose precise, reversible graph operations. Explain evidence for relations.",
    permissions: ["documents.read", "graph.read", "graph.edit", "targets.read", "sources.external"],
    actions: ["inspect", "relate", "merge", "layout", "focus"],
    accepts: ["*"],
    outputs: ["relation"],
    autonomy: "bounded",
    review: "destructive",
    retry: { maxAttempts: 2, backoffMs: 1_000 },
    budget: { maxCostUsd: 1, maxIterations: 12, maxToolCalls: 36, maxRuntimeMs: 600_000 }
  },
  {
    id: "actor-builder",
    name: "Actor builder",
    instructions:
      "Create Quasar actors as declarative transforms. Validate and test them before saving. Never access PouchDB, Cytoscape, application state, or secrets directly.",
    permissions: ["documents.read", "actors.run", "actors.create", "actors.edit"],
    actions: ["inspect", "create_actor", "test_actor", "repair_actor"],
    accepts: ["*"],
    outputs: ["actor"],
    autonomy: "bounded",
    review: "save-actor",
    retry: { maxAttempts: 3, backoffMs: 500 },
    budget: { maxCostUsd: 1, maxIterations: 12, maxToolCalls: 30, maxRuntimeMs: 600_000 }
  },
  {
    id: "supervisor",
    name: "Supervisor",
    instructions:
      "Drive a bounded run, measure progress, stop on loops or budget limits, and request approval when required.",
    permissions: ["documents.read", "graph.read", "actors.run", "targets.read"],
    actions: ["inspect", "plan", "delegate", "pause", "stop", "recover"],
    accepts: ["*"],
    outputs: ["run-summary"],
    autonomy: "supervised",
    review: "mutations",
    retry: { maxAttempts: 3, backoffMs: 1_500 },
    budget: { maxCostUsd: 2, maxIterations: 25, maxToolCalls: 75, maxRuntimeMs: 1_200_000 }
  },
  {
    id: "recovery",
    name: "Recovery agent",
    instructions:
      "Inspect the failed step, choose one bounded recovery action, and avoid unchanged retries.",
    permissions: ["documents.read", "graph.read", "actors.run", "targets.read"],
    actions: ["inspect", "retry", "restore", "shrink-context", "fallback-model", "pause", "stop"],
    accepts: ["*"],
    outputs: ["recovery-action"],
    autonomy: "supervised",
    review: "always",
    retry: { maxAttempts: 2, backoffMs: 2_000 },
    budget: { maxCostUsd: 0.5, maxIterations: 5, maxToolCalls: 10, maxRuntimeMs: 300_000 }
  }
]);

const PREFIX = "agent-system:";
const AGENT_PACK_SECTIONS = Object.freeze({
  roles: AGENT_RECORD_TYPES.role,
  agents: AGENT_RECORD_TYPES.agent,
  providers: AGENT_RECORD_TYPES.provider,
  models: AGENT_RECORD_TYPES.model,
  budgets: AGENT_RECORD_TYPES.budget,
  skills: AGENT_RECORD_TYPES.skill,
  mcpServers: AGENT_RECORD_TYPES.mcpServer
});
const IMPORT_ORDER = Object.freeze([
  AGENT_RECORD_TYPES.role,
  AGENT_RECORD_TYPES.provider,
  AGENT_RECORD_TYPES.model,
  AGENT_RECORD_TYPES.budget,
  AGENT_RECORD_TYPES.skill,
  AGENT_RECORD_TYPES.mcpServer,
  AGENT_RECORD_TYPES.agent
]);
const SECRET_FIELD =
  /^(?:api[-_]?key|secret|access[-_]?token|refresh[-_]?token|authorization|password)$/i;

function now() {
  return new Date().toISOString();
}

function cleanId(value, label = "ID") {
  const id = String(value || "").trim();
  if (!id) throw new TypeError(`${label} is required`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id))
    throw new TypeError(`${label} contains invalid characters`);
  return id;
}

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function recordId(type, id) {
  return `${PREFIX}${type}:${cleanId(id)}`;
}

function stripPouchFields(record) {
  const result = clone(record);
  delete result._rev;
  return result;
}

function assertSecretFree(value, path = "payload") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretFree(item, `${path}[${index}]`));
    return;
  }
  for (const [name, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(name))
      throw new TypeError(`Imported config cannot contain secrets: ${path}.${name}`);
    assertSecretFree(item, `${path}.${name}`);
  }
}

function packAgentInput(input) {
  return {
    ...input,
    roleId: input.roleId ?? input.role ?? "researcher",
    providerId: input.providerId ?? input.provider ?? "openrouter",
    modelId: input.modelId ?? input.model ?? "",
    systemPrompt: input.systemPrompt ?? input.system_prompt ?? "",
    recordType: AGENT_RECORD_TYPES.agent
  };
}

function packRoleInput(input) {
  return {
    ...input,
    instructions: input.instructions ?? input.systemPrompt ?? input.system_prompt ?? "",
    recordType: AGENT_RECORD_TYPES.role
  };
}

function normalizeImportedRecord(input) {
  if (input.recordType === AGENT_RECORD_TYPES.agent) return normalizeAgent(packAgentInput(input));
  if (input.recordType === AGENT_RECORD_TYPES.role) return normalizeRole(packRoleInput(input));
  return normalizeAgentRecord(input);
}

export function normalizeAgentRecord(record, expectedType) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Agent record must be an object");
  }
  const type = String(record.recordType || expectedType || "");
  if (!Object.values(AGENT_RECORD_TYPES).includes(type))
    throw new TypeError(`Unknown agent record type: ${type || "<missing>"}`);
  if (expectedType && type !== expectedType)
    throw new TypeError(`Expected ${expectedType}, received ${type}`);
  const id = cleanId(record.id);
  return {
    ...clone(record),
    _id: recordId(type, id),
    id,
    recordType: type,
    schemaVersion: AGENT_SCHEMA_VERSION,
    createdAt: record.createdAt || now(),
    updatedAt: now()
  };
}

export function normalizeRole(input) {
  const role = normalizeAgentRecord(
    {
      ...input,
      id: input.id,
      recordType: AGENT_RECORD_TYPES.role
    },
    AGENT_RECORD_TYPES.role
  );
  role.name = String(input.name || "").trim();
  role.instructions = String(input.instructions || "").trim();
  role.permissions = [...new Set((input.permissions || []).map(String))];
  role.actions = [...new Set((input.actions || []).map(String))];
  role.accepts = [...new Set((input.accepts || ["*"]).map(String))];
  role.outputs = [...new Set((input.outputs || []).map(String))];
  role.permissionProfileVersion = Number(
    input.permissionProfileVersion || DEFAULT_PERMISSION_PROFILE_VERSION
  );
  if (!role.name) throw new TypeError("Role name is required");
  for (const permission of role.permissions) {
    if (!AGENT_PERMISSIONS.includes(permission))
      throw new TypeError(`Unknown permission: ${permission}`);
  }
  return role;
}

export function normalizeAgent(input) {
  const agent = normalizeAgentRecord(
    {
      ...input,
      recordType: AGENT_RECORD_TYPES.agent
    },
    AGENT_RECORD_TYPES.agent
  );
  agent.name = String(input.name || "").trim();
  agent.description = String(input.description || "").trim();
  agent.roleId = cleanId(input.roleId || "researcher", "Role ID");
  agent.systemPrompt = String(input.systemPrompt || "").trim();
  agent.providerId = cleanId(input.providerId || "openrouter", "Provider ID");
  agent.modelId = String(input.modelId || "").trim();
  agent.permissions = [...new Set((input.permissions || []).map(String))];
  agent.permissionProfileVersion = Number(
    input.permissionProfileVersion || DEFAULT_PERMISSION_PROFILE_VERSION
  );
  agent.datasetAccess = [...new Set((input.datasetAccess || ["*"]).map(String))];
  agent.graphAccess = [...new Set((input.graphAccess || ["*"]).map(String))];
  agent.targetAccess = [...new Set((input.targetAccess || ["*"]).map(String))];
  agent.actorAccess = [...new Set((input.actorAccess || ["*"]).map(String))];
  agent.skillIds = [...new Set((input.skillIds || []).map(String))];
  agent.mcpServerIds = [...new Set((input.mcpServerIds || []).map(String))];
  agent.enabled = input.enabled !== false;
  agent.loop = {
    maxIterations: 20,
    maxRuntimeMs: 900_000,
    maxToolCalls: 60,
    maxTokens: 200_000,
    maxConsecutiveFailures: 3,
    maxRepeatedActions: 3,
    maxRepeatedResults: 3,
    ...input.loop
  };
  agent.recovery = {
    retries: 3,
    backoffMs: 1_000,
    smallerContext: true,
    fallbackModelId: "",
    ...input.recovery
  };
  agent.memory = {
    run: true,
    agent: true,
    target: true,
    dataset: false,
    ...input.memory
  };
  agent.budget = {
    maxCostUsd: 2,
    dailyCostUsd: 10,
    monthlyCostUsd: 100,
    maxInputTokens: 150_000,
    maxOutputTokens: 50_000,
    maxToolCalls: agent.loop.maxToolCalls,
    maxIterations: agent.loop.maxIterations,
    maxRuntimeMs: agent.loop.maxRuntimeMs,
    softLimitRatio: 0.8,
    ...input.budget
  };
  if (!agent.name) throw new TypeError("Agent name is required");
  if (!agent.modelId) throw new TypeError("Model is required");
  for (const permission of agent.permissions) {
    if (!AGENT_PERMISSIONS.includes(permission))
      throw new TypeError(`Unknown permission: ${permission}`);
  }
  return agent;
}

export async function saveAgentRecord(input, expectedType) {
  const record = normalizeAgentRecord(input, expectedType);
  const stored = await putState(record._id, stripPouchFields(record));
  return stripPouchFields(stored);
}

export async function saveAgent(input) {
  return saveAgentRecord(normalizeAgent(input), AGENT_RECORD_TYPES.agent);
}

export async function saveRole(input) {
  return saveAgentRecord(normalizeRole(input), AGENT_RECORD_TYPES.role);
}

export async function getAgentRecord(type, id) {
  const record = await getState(recordId(type, id), null);
  return record ? stripPouchFields(record) : null;
}

export async function listAgentRecords(type) {
  const result = await stateDb.allDocs({
    startkey: PREFIX,
    endkey: `${PREFIX}\ufff0`,
    include_docs: true
  });
  return result.rows
    .map((row) => row.doc)
    .filter(Boolean)
    .filter((record) => !type || record.recordType === type)
    .map(stripPouchFields)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export async function removeAgentRecord(type, id) {
  const key = recordId(type, id);
  const current = await getState(key, null);
  if (!current) return false;
  await stateDb.remove(current);
  return true;
}

export async function ensureDefaultRoles() {
  const existingRoles = await listAgentRecords(AGENT_RECORD_TYPES.role);
  const existing = new Map(existingRoles.map((role) => [role.id, role]));
  for (const role of DEFAULT_ROLES) {
    const saved = existing.get(role.id);
    if (!saved) {
      await saveRole({ ...role, permissionProfileVersion: DEFAULT_PERMISSION_PROFILE_VERSION });
      continue;
    }
    if (Number(saved.permissionProfileVersion || 0) < DEFAULT_PERMISSION_PROFILE_VERSION) {
      await saveRole({
        ...saved,
        permissions: [
          ...new Set([
            ...(saved.permissions || []),
            ...(DEFAULT_PERMISSION_UPGRADES[role.id] || [])
          ])
        ],
        permissionProfileVersion: DEFAULT_PERMISSION_PROFILE_VERSION
      });
    }
  }
  const agents = await listAgentRecords(AGENT_RECORD_TYPES.agent);
  for (const agent of agents) {
    const permissions = DEFAULT_PERMISSION_UPGRADES[agent.roleId];
    if (
      !permissions ||
      Number(agent.permissionProfileVersion || 0) >= DEFAULT_PERMISSION_PROFILE_VERSION
    )
      continue;
    await saveAgent({
      ...agent,
      permissions: [...new Set([...(agent.permissions || []), ...permissions])],
      permissionProfileVersion: DEFAULT_PERMISSION_PROFILE_VERSION
    });
  }
  return listAgentRecords(AGENT_RECORD_TYPES.role);
}

export function normalizeAgentSystemImport(payload) {
  assertSecretFree(payload);
  let records;
  let metadata;
  if (payload?.format === "quasar-agent-system" && Array.isArray(payload.records)) {
    records = payload.records;
    metadata = {
      format: payload.format,
      version: Number(payload.version || AGENT_SCHEMA_VERSION),
      name: String(payload.name || "Agent system export"),
      description: String(payload.description || "")
    };
  } else if (payload?.format === AGENT_PACK_FORMAT) {
    if (Number(payload.version || 0) !== AGENT_PACK_VERSION) {
      throw new TypeError(
        `Unsupported Quasar agent pack version: ${payload.version || "<missing>"}`
      );
    }
    records = Object.entries(AGENT_PACK_SECTIONS).flatMap(([section, recordType]) => {
      const items = payload[section] || [];
      if (!Array.isArray(items))
        throw new TypeError(`Agent pack field must be an array: ${section}`);
      return items.map((item) => ({
        ...item,
        recordType,
        ...(recordType === AGENT_RECORD_TYPES.agent ? packAgentInput(item) : {}),
        ...(recordType === AGENT_RECORD_TYPES.role ? packRoleInput(item) : {})
      }));
    });
    metadata = {
      format: payload.format,
      version: AGENT_PACK_VERSION,
      name: String(payload.name || "Agent config pack"),
      description: String(payload.description || "")
    };
  } else {
    throw new TypeError("Invalid Quasar agent config pack");
  }

  const seen = new Set();
  const normalized = records.map((input) => {
    const record = normalizeImportedRecord(input);
    const key = `${record.recordType}:${record.id}`;
    if (seen.has(key))
      throw new TypeError(`Duplicate imported record: ${record.id} (${record.recordType})`);
    seen.add(key);
    return record;
  });
  const counts = normalized.reduce((result, record) => {
    result[record.recordType] = (result[record.recordType] || 0) + 1;
    return result;
  }, {});
  return { ...metadata, records: normalized, counts };
}

export async function exportAgentSystemRecords({ includeRuns = false } = {}) {
  const allowed = new Set([
    AGENT_RECORD_TYPES.agent,
    AGENT_RECORD_TYPES.role,
    AGENT_RECORD_TYPES.provider,
    AGENT_RECORD_TYPES.model,
    AGENT_RECORD_TYPES.budget,
    AGENT_RECORD_TYPES.skill,
    AGENT_RECORD_TYPES.mcpServer
  ]);
  if (includeRuns) {
    [
      AGENT_RECORD_TYPES.run,
      AGENT_RECORD_TYPES.step,
      AGENT_RECORD_TYPES.checkpoint,
      AGENT_RECORD_TYPES.cost,
      AGENT_RECORD_TYPES.toolCall,
      AGENT_RECORD_TYPES.loopEvent,
      AGENT_RECORD_TYPES.recoveryEvent,
      AGENT_RECORD_TYPES.memory
    ].forEach((type) => allowed.add(type));
  }
  const records = (await listAgentRecords()).filter((record) => allowed.has(record.recordType));
  return {
    format: "quasar-agent-system",
    version: AGENT_SCHEMA_VERSION,
    exportedAt: now(),
    secretsIncluded: false,
    records: records.map(({ secret, apiKey, ...record }) => {
      if (record.recordType !== AGENT_RECORD_TYPES.mcpServer) return record;
      const headers = Object.fromEntries(
        Object.entries(record.headers || {}).filter(
          ([name]) => !/authorization|api[-_]?key|token|secret/i.test(name)
        )
      );
      return { ...record, headers };
    })
  };
}

export async function importAgentSystemRecords(payload, { replace = false, conflictMode } = {}) {
  const imported = normalizeAgentSystemImport(payload);
  const mode = conflictMode || (replace ? "replace" : "error");
  if (!["error", "skip", "replace"].includes(mode))
    throw new TypeError(`Unknown import conflict mode: ${mode}`);

  const importedRoleIds = new Set(
    imported.records
      .filter((record) => record.recordType === AGENT_RECORD_TYPES.role)
      .map((record) => record.id)
  );
  for (const agent of imported.records.filter(
    (record) => record.recordType === AGENT_RECORD_TYPES.agent
  )) {
    if (importedRoleIds.has(agent.roleId)) continue;
    const existingRole = await getState(recordId(AGENT_RECORD_TYPES.role, agent.roleId), null);
    if (!existingRole)
      throw new TypeError(`Agent ${agent.id} references unknown role: ${agent.roleId}`);
  }

  const conflicts = [];
  const staged = [];
  let replaced = 0;
  let skipped = 0;
  let created = 0;
  for (const record of imported.records) {
    const existing = await getState(record._id, null);
    if (!existing) {
      staged.push(record);
      created += 1;
      continue;
    }
    conflicts.push({ id: record.id, recordType: record.recordType });
    if (mode === "replace") {
      staged.push(record);
      replaced += 1;
    } else if (mode === "skip") {
      skipped += 1;
    }
  }
  if (conflicts.length && mode === "error") {
    return {
      applied: 0,
      created: 0,
      replaced: 0,
      skipped: 0,
      conflicts,
      counts: imported.counts
    };
  }

  staged.sort(
    (left, right) => IMPORT_ORDER.indexOf(left.recordType) - IMPORT_ORDER.indexOf(right.recordType)
  );
  for (const record of staged) await saveAgentRecord(record, record.recordType);
  return {
    applied: staged.length,
    created,
    replaced,
    skipped,
    conflicts,
    counts: imported.counts
  };
}
