import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  getState: vi.fn(),
  putState: vi.fn(),
  stateDb: {}
}));
import { getState, putState } from "./db";
import {
  AGENT_PACK_FORMAT,
  AGENT_RECORD_TYPES,
  DEFAULT_ROLES,
  importAgentSystemRecords,
  normalizeAgent,
  normalizeAgentSystemImport,
  normalizeRole
} from "./agent-records";

const pack = {
  format: AGENT_PACK_FORMAT,
  version: 1,
  name: "Test operators",
  roles: [
    {
      id: "pack-researcher",
      name: "Pack researcher",
      instructions: "Keep facts and inference separate.",
      permissions: ["documents.read", "graph.read"]
    }
  ],
  agents: [
    {
      id: "pack-operator",
      name: "Pack operator",
      role: "pack-researcher",
      provider: "openrouter",
      model: "test/model",
      system_prompt: "Use the imported operating procedure.",
      permissions: ["documents.read", "graph.read"]
    }
  ]
};

describe("agent records", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getState.mockImplementation(async (_id, fallback) => fallback ?? null);
    putState.mockImplementation(async (id, value) => ({ ...value, _id: id }));
  });

  it("normalizes persistent agents with bounded defaults", () => {
    const agent = normalizeAgent({
      id: "operator",
      name: "Operator",
      roleId: "researcher",
      providerId: "openrouter",
      modelId: "test/model",
      permissions: ["documents.read"]
    });
    expect(agent.recordType).toBe(AGENT_RECORD_TYPES.agent);
    expect(agent.loop.maxIterations).toBeGreaterThan(0);
    expect(agent.budget.maxCostUsd).toBeGreaterThan(0);
  });

  it("rejects unknown role permissions", () => {
    expect(() =>
      normalizeRole({
        id: "bad",
        name: "Bad",
        permissions: ["root.shell"]
      })
    ).toThrow("Unknown permission");
  });

  it("gives the default operator roles graph editing and external sources", () => {
    for (const roleId of ["researcher", "graph-analyst"]) {
      const role = DEFAULT_ROLES.find((candidate) => candidate.id === roleId);
      expect(role.permissions).toContain("graph.edit");
      expect(role.permissions).toContain("sources.external");
    }
  });

  it("normalizes a bulk config pack with roles and system prompts", () => {
    const imported = normalizeAgentSystemImport(pack);
    const role = imported.records.find((record) => record.recordType === AGENT_RECORD_TYPES.role);
    const agent = imported.records.find((record) => record.recordType === AGENT_RECORD_TYPES.agent);

    expect(imported.name).toBe("Test operators");
    expect(role.instructions).toBe("Keep facts and inference separate.");
    expect(agent.roleId).toBe(role.id);
    expect(agent.systemPrompt).toBe("Use the imported operating procedure.");
  });

  it("rejects duplicate records and embedded secrets", () => {
    expect(() =>
      normalizeAgentSystemImport({
        ...pack,
        agents: [...pack.agents, { ...pack.agents[0] }]
      })
    ).toThrow("Duplicate imported record");
    expect(() =>
      normalizeAgentSystemImport({
        ...pack,
        providers: [{ id: "unsafe", apiKey: "nope" }]
      })
    ).toThrow("cannot contain secrets");
  });

  it("installs roles before agents", async () => {
    const result = await importAgentSystemRecords(pack);
    const recordWrites = putState.mock.calls
      .filter(([id]) => id.includes("agent-system:quasar."))
      .map(([id]) => id);

    expect(result.applied).toBe(2);
    expect(recordWrites[0]).toContain(AGENT_RECORD_TYPES.role);
    expect(recordWrites[1]).toContain(AGENT_RECORD_TYPES.agent);
  });
});
