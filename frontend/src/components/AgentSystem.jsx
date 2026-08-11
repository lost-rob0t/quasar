import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Bot,
  ChevronDown,
  CircleDollarSign,
  Expand,
  GripVertical,
  MessageSquareCode,
  Pause,
  Play,
  RotateCcw,
  Search,
  Square,
  X
} from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  AGENT_PERMISSIONS,
  AGENT_RECORD_TYPES,
  DEFAULT_ROLES,
  ensureDefaultRoles,
  exportAgentSystemRecords,
  getAgentRecord,
  listAgentRecords,
  importAgentSystemRecords,
  normalizeAgent,
  removeAgentRecord,
  saveAgent,
  saveAgentRecord,
  saveRole
} from "../lib/agent-records";
import { actorWithTransformEnvelope, buildActorTransform } from "../lib/actor-transforms";
import { normalizeActorManifest, runBrowserActor } from "../lib/actors";
import { budgetState, remainingBudget } from "../lib/agent-budget";
import { filterAgentChats } from "../lib/agent-chat-search";
import { buildAgentContext, systemPromptForAgent } from "../lib/agent-context";
import {
  deleteProviderSecret,
  getProviderSecret,
  hasProviderSecret,
  setProviderSecret
} from "../lib/agent-secrets";
import { AgentSupervisor, runStateFingerprint } from "../lib/agent-supervisor";
import { createAgentToolRegistry } from "../lib/agent-tools";
import { braveWebSearch, fetchUrlContent, scrapeWebsite } from "../lib/agent-web";
import { applyAgentGraphPlan, previewAgentGraphOperations } from "../lib/agent-graph-operations";
import {
  DEFAULT_PROVIDER_CONFIGS,
  createProviderAdapter,
  normalizeProviderConfig,
  testProviderConnection
} from "../lib/provider-adapters";
import { McpHttpClient, testMcpServer } from "../lib/mcp-client";
import { useQuasar } from "../store";

const AgentSystemContext = createContext(null);
const BUBBLE_POSITION_KEY = "quasar:agent-bubble-position";
const SLASH_COMMANDS = [
  "/run",
  "/pause",
  "/resume",
  "/stop",
  "/retry",
  "/budget",
  "/cost",
  "/target",
  "/dataset",
  "/graph",
  "/actor",
  "/role",
  "/skill",
  "/mcp",
  "/web",
  "/tools",
  "/inspect",
  "/checkpoint",
  "/rollback",
  "/clear"
];
const AGENT_TABS = ["run", "agents", "roles", "providers", "web", "mcp", "skills", "memory"];
let initializationPromise = null;

function initializeAgentRecords() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await ensureDefaultRoles();
      for (const config of DEFAULT_PROVIDER_CONFIGS) {
        const existing = await getAgentRecord(AGENT_RECORD_TYPES.provider, config.id);
        if (!existing) {
          await saveAgentRecord(
            {
              ...config,
              recordType: AGENT_RECORD_TYPES.provider
            },
            AGENT_RECORD_TYPES.provider
          );
        }
      }
    })().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }
  return initializationPromise;
}

function loadBubblePosition() {
  try {
    return (
      JSON.parse(localStorage.getItem(BUBBLE_POSITION_KEY)) || { dock: "right", x: null, y: null }
    );
  } catch {
    return { dock: "right", x: null, y: null };
  }
}

function defaultAgentInput(role, provider) {
  return {
    id: `agent-${crypto.randomUUID().slice(0, 8)}`,
    name: "Operator",
    description: "Quasar investigation operator",
    roleId: role?.id || "researcher",
    systemPrompt: "",
    providerId: provider?.id || "openrouter",
    modelId: "",
    permissions: role?.permissions || [
      "documents.read",
      "graph.read",
      "actors.run",
      "targets.read"
    ],
    datasetAccess: ["*"],
    graphAccess: ["*"],
    targetAccess: ["*"],
    actorAccess: ["*"],
    enabled: true
  };
}

function activeDataset(documents, selectionIds) {
  const selected = documents.find((document) => selectionIds.includes(document._id));
  return selected?.dataset || null;
}

export function AgentSystemProvider({ children }) {
  const quasar = useQuasar();
  const [agents, setAgents] = useState([]);
  const [roles, setRoles] = useState([]);
  const [providers, setProviders] = useState([]);
  const [runs, setRuns] = useState([]);
  const [memories, setMemories] = useState([]);
  const [costs, setCosts] = useState([]);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [activeAgentId, setActiveAgentId] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [ready, setReady] = useState(false);
  const quasarRef = useRef(quasar);
  const providersRef = useRef(providers);
  quasarRef.current = quasar;
  providersRef.current = providers;

  const refresh = useCallback(async () => {
    const [
      nextAgents,
      nextRoles,
      nextProviders,
      nextRuns,
      nextMemories,
      nextCosts,
      nextSkills,
      nextMcpServers
    ] = await Promise.all([
      listAgentRecords(AGENT_RECORD_TYPES.agent),
      listAgentRecords(AGENT_RECORD_TYPES.role),
      listAgentRecords(AGENT_RECORD_TYPES.provider),
      listAgentRecords(AGENT_RECORD_TYPES.run),
      listAgentRecords(AGENT_RECORD_TYPES.memory),
      listAgentRecords(AGENT_RECORD_TYPES.cost),
      listAgentRecords(AGENT_RECORD_TYPES.skill),
      listAgentRecords(AGENT_RECORD_TYPES.mcpServer)
    ]);
    setAgents(nextAgents);
    setRoles(nextRoles);
    setProviders(nextProviders);
    setRuns(nextRuns);
    setMemories(nextMemories);
    setCosts(nextCosts);
    setSkills(nextSkills);
    setMcpServers(nextMcpServers);
    setActiveAgentId((current) => current || nextAgents[0]?.id || "");
    setActiveRunId((current) => current || nextRuns[0]?.id || "");
  }, []);

  const environment = useMemo(
    () => ({
      getDocuments: async () => quasarRef.current.documents,
      getGraphDocuments: async () => {
        const current = quasarRef.current;
        const membership = current.activeGraph?.documentIds;
        return membership === null
          ? current.documents
          : current.documents.filter((document) => membership?.includes(document._id));
      },
      getPositions: () => quasarRef.current.workspace?.positions || {},
      async runActor(actorId, selectionIds) {
        const actor = quasarRef.current.actors.find((candidate) => candidate.id === actorId);
        if (!actor) throw new Error(`Actor not found: ${actorId}`);
        const result = await quasarRef.current.runActor(actor, selectionIds);
        return {
          message: result.message,
          operationCount: result.operationCount,
          counts: result.counts,
          affected: [
            ...result.documents.map((document) => ({
              id: document._id,
              objectType: document.dtype,
              action: "save"
            })),
            ...result.removedIds.map((id) => ({ id, action: "remove" }))
          ]
        };
      },
      webSearch(args) {
        return braveWebSearch(args.query, {
          apiKey: getProviderSecret("brave-search"),
          count: args.count,
          country: args.country,
          freshness: args.freshness
        });
      },
      fetchUrl(url) {
        const settings = quasarRef.current.settings || {};
        return fetchUrlContent(url, {
          gatewayUrl: settings.webFetchGatewayUrl,
          gatewayToken: getProviderSecret("web-fetch-gateway", {
            type: "web-fetch-gateway",
            url: settings.webFetchGatewayUrl
          })
        });
      },
      scrapeWebsite(args) {
        const settings = quasarRef.current.settings || {};
        return scrapeWebsite(args.url, {
          maxPages: args.maxPages,
          maxDepth: args.maxDepth,
          sameOrigin: args.sameOrigin,
          gatewayUrl: settings.webFetchGatewayUrl,
          gatewayToken: getProviderSecret("web-fetch-gateway", {
            type: "web-fetch-gateway",
            url: settings.webFetchGatewayUrl
          })
        });
      },
      async callMcp(serverId, toolName, args, context) {
        const allowed = new Set(context.agent.mcpServerIds || []);
        if (!allowed.has(serverId)) throw new Error(`MCP server access denied: ${serverId}`);
        const server = await getAgentRecord(AGENT_RECORD_TYPES.mcpServer, serverId);
        if (!server?.enabled) throw new Error(`MCP server is disabled: ${serverId}`);
        if (server.allowedTools?.length && !server.allowedTools.includes(toolName))
          throw new Error(`MCP tool access denied: ${toolName}`);
        const client = new McpHttpClient(server, getProviderSecret(`mcp:${serverId}`, server));
        await client.initialize();
        const result = await client.callTool(toolName, args);
        return {
          serverId,
          toolName,
          content: result.content || [],
          isError: Boolean(result.isError)
        };
      },
      async buildCustomGraph(args, context) {
        const current = quasarRef.current;
        const allowedDatasets = new Set(context.agent.datasetAccess || ["*"]);
        const query = args.query || {};
        let selected = current.documents.filter(
          (document) =>
            (allowedDatasets.has("*") || allowedDatasets.has(document.dataset)) &&
            (!query.datasets?.length || query.datasets.includes(document.dataset)) &&
            (!query.objectTypes?.length || query.objectTypes.includes(document.dtype)) &&
            (!query.text ||
              JSON.stringify(document).toLowerCase().includes(String(query.text).toLowerCase()))
        );
        if (args.documentIds?.length) {
          const ids = new Set(args.documentIds);
          selected = current.documents.filter(
            (document) =>
              ids.has(document._id) &&
              (allowedDatasets.has("*") || allowedDatasets.has(document.dataset))
          );
        }
        selected = selected.filter((document) => document.dtype !== "relation").slice(0, 500);
        const ids = new Set(selected.map((document) => document._id));
        if (args.includeRelations !== false) {
          current.documents
            .filter((document) => {
              if (document.dtype !== "relation") return false;
              const source = document.data?.subject || document.data?.source;
              const target = document.data?.object || document.data?.target;
              return (
                typeof source === "string" &&
                typeof target === "string" &&
                ids.has(source) &&
                ids.has(target)
              );
            })
            .forEach((document) => ids.add(document._id));
        }
        const graph = current.createGraph(args.name);
        current.addDocumentsToActiveGraph([...ids], { layout: args.layout || "cose" });
        window.dispatchEvent(
          new CustomEvent("quasar:agent-graph-command", {
            detail: { op: "apply_layout", layout: args.layout || "cose" }
          })
        );
        return {
          graphId: graph.activeGraphId,
          name: args.name,
          documentCount: ids.size,
          affected: [...ids].map((id) => ({ id, action: "add-to-graph" }))
        };
      },
      async previewGraphOperations(operations, context) {
        const plan = previewAgentGraphOperations(quasarRef.current.documents, operations, {
          agentId: context.agent.id,
          runId: context.run.id
        });
        return {
          valid: true,
          summary: plan.summary,
          changes: plan.changes,
          requiresApproval: plan.requiresApproval
        };
      },
      async applyGraphOperations(operations, context) {
        const plan = previewAgentGraphOperations(quasarRef.current.documents, operations, {
          agentId: context.agent.id,
          runId: context.run.id
        });
        return applyAgentGraphPlan(
          plan,
          {
            execute: quasarRef.current.execute,
            async applyWorkspaceOperation(workspaceOperation) {
              const current = quasarRef.current;
              if (workspaceOperation.op === "move_node") {
                const id = String(workspaceOperation.id || "");
                const position = workspaceOperation.position;
                if (!id || !Number.isFinite(position?.x) || !Number.isFinite(position?.y))
                  throw new TypeError("Move node requires an ID and numeric position");
                current.persistWorkspace({
                  positions: { ...(current.workspace?.positions || {}), [id]: position }
                });
                return;
              }
              if (workspaceOperation.op === "create_graph") {
                current.createGraph(workspaceOperation.name || "Agent graph");
                return;
              }
              if (workspaceOperation.op === "add_to_graph") {
                current.addDocumentsToActiveGraph(workspaceOperation.ids || []);
                return;
              }
              if (workspaceOperation.op === "remove_from_graph") {
                current.removeDocumentsFromActiveGraph(workspaceOperation.ids || []);
                return;
              }
              if (workspaceOperation.op === "apply_layout") {
                current.persistWorkspace({ layout: workspaceOperation.layout || "cose" });
                window.dispatchEvent(
                  new CustomEvent("quasar:agent-graph-command", { detail: workspaceOperation })
                );
                return;
              }
              if (workspaceOperation.op === "focus_selection") {
                current.select(workspaceOperation.ids || []);
                window.dispatchEvent(
                  new CustomEvent("quasar:agent-graph-command", { detail: workspaceOperation })
                );
                return;
              }
              if (workspaceOperation.op === "fit_graph") {
                window.dispatchEvent(
                  new CustomEvent("quasar:agent-graph-command", { detail: workspaceOperation })
                );
                return;
              }
              if (
                ["create_group", "collapse_group", "expand_group"].includes(workspaceOperation.op)
              ) {
                const groups = { ...(current.workspace?.groups || {}) };
                const groupId =
                  workspaceOperation.groupId || `group-${crypto.randomUUID().slice(0, 8)}`;
                const previous = groups[groupId] || {
                  id: groupId,
                  name: workspaceOperation.name || groupId,
                  documentIds: []
                };
                groups[groupId] = {
                  ...previous,
                  documentIds: workspaceOperation.ids || previous.documentIds,
                  collapsed:
                    workspaceOperation.op === "collapse_group"
                      ? true
                      : workspaceOperation.op === "expand_group"
                        ? false
                        : Boolean(workspaceOperation.collapsed)
                };
                current.persistWorkspace({ groups });
                return;
              }
              throw new Error(`Unsupported workspace operation: ${workspaceOperation.op}`);
            }
          },
          { approved: context.agent.permissions?.includes("destructive") }
        );
      },
      async validateActor(actorInput, sampleDocumentIds, context) {
        const actor = normalizeActorManifest(actorInput);
        const current = quasarRef.current;
        const sample = current.documents.filter((document) =>
          sampleDocumentIds.includes(document._id)
        );
        const result = await runBrowserActor(actorWithTransformEnvelope(actor), {
          selection: sample,
          documents: current.documents.map((document) => ({ ...document })),
          workspace: { layout: current.workspace?.layout || "cose" }
        });
        const transform = buildActorTransform(
          result,
          current.documents,
          `Test actor: ${actor.label}`
        );
        const candidate = await saveAgentRecord(
          {
            id: `actor-candidate:${crypto.randomUUID()}`,
            recordType: AGENT_RECORD_TYPES.generatedActor,
            agentId: context.agent.id,
            runId: context.run.id,
            actor,
            validation: {
              valid: true,
              testedAt: new Date().toISOString(),
              sampleDocumentIds,
              operationCount: transform.operationCount,
              counts: transform.counts,
              message: transform.message
            },
            saved: false
          },
          AGENT_RECORD_TYPES.generatedActor
        );
        return {
          candidateId: candidate.id,
          actor: {
            id: actor.id,
            label: actor.label,
            version: actor.version,
            accepts: actor.accepts
          },
          test: candidate.validation
        };
      },
      async saveValidatedActor(candidateId, context) {
        const candidate = await getAgentRecord(AGENT_RECORD_TYPES.generatedActor, candidateId);
        if (!candidate?.validation?.valid)
          throw new Error("Actor candidate has not passed validation");
        if (candidate.agentId !== context.agent.id)
          throw new Error("Actor candidate belongs to another agent");
        const current = quasarRef.current;
        const actors = [
          ...(current.settings?.actors || []).filter((actor) => actor.id !== candidate.actor.id),
          candidate.actor
        ];
        await current.persistSettings({ actors });
        await saveAgentRecord(
          {
            ...candidate,
            saved: true,
            savedAt: new Date().toISOString()
          },
          AGENT_RECORD_TYPES.generatedActor
        );
        return {
          saved: true,
          actorId: candidate.actor.id,
          affected: [{ id: candidate.actor.id, action: "save-actor" }]
        };
      }
    }),
    []
  );

  const toolRegistry = useMemo(() => createAgentToolRegistry(environment), [environment]);
  const supervisor = useMemo(
    () =>
      new AgentSupervisor({
        adapterFor: async (agent) => {
          const provider = await getAgentRecord(AGENT_RECORD_TYPES.provider, agent.providerId);
          if (!provider) throw new Error(`Provider not found: ${agent.providerId}`);
          return createProviderAdapter(provider, getProviderSecret(provider.id, provider));
        },
        toolRegistry,
        contextFor: async (agent, run) => {
          const role = await getAgentRecord(AGENT_RECORD_TYPES.role, agent.roleId);
          const assignedSkills = (await listAgentRecords(AGENT_RECORD_TYPES.skill)).filter(
            (skill) => agent.skillIds?.includes(skill.id) && skill.enabled !== false
          );
          const assignedMcpServers = (await listAgentRecords(AGENT_RECORD_TYPES.mcpServer)).filter(
            (server) => agent.mcpServerIds?.includes(server.id) && server.enabled !== false
          );
          const current = quasarRef.current;
          const context = buildAgentContext({
            documents: current.documents,
            selectionIds: run.selectionIds,
            targetIds: run.targetIds,
            dataset: run.dataset,
            graph: current.activeGraph,
            filters: run.filters
          });
          const skillInstructions = assignedSkills
            .map((skill) => `Skill: ${skill.name}\n${skill.instructions}`)
            .join("\n\n");
          const mcpInstructions = assignedMcpServers.length
            ? `Assigned MCP servers:\n${assignedMcpServers.map((server) => `- ${server.id}: ${(server.allowedTools || []).join(", ") || "tools discovered at runtime"}`).join("\n")}`
            : "";
          return {
            context,
            systemPrompt: [
              systemPromptForAgent(agent, role, context),
              skillInstructions,
              mcpInstructions
            ]
              .filter(Boolean)
              .join("\n\n")
          };
        },
        pricingFor: (providerId, modelId) => {
          const configured = quasarRef.current.settings?.agentModelPricing?.[modelId];
          if (configured) return { ...configured, known: true };
          const provider = providersRef.current.find((candidate) => candidate.id === providerId);
          if (provider?.type === "local") return { known: true, free: true };
          return { known: false };
        },
        stateFingerprint: async () =>
          runStateFingerprint(quasarRef.current.documents, quasarRef.current.activeGraph),
        onUpdate: (run) => {
          setRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)]);
          setActiveRunId(run.id);
        }
      }),
    [toolRegistry]
  );

  useEffect(() => {
    let active = true;
    (async () => {
      await initializeAgentRecords();
      await supervisor.restoreInterruptedRuns();
      if (active) {
        await refresh();
        setReady(true);
      }
    })().catch((error) => quasarRef.current.setNotice({ kind: "error", message: error.message }));
    return () => {
      active = false;
    };
  }, [refresh, supervisor]);

  const activeAgent = agents.find((agent) => agent.id === activeAgentId) || null;
  const activeRun = runs.find((run) => run.id === activeRunId) || null;

  const runCommand = useCallback(
    async (goal, { loopEnabled = false } = {}) => {
      if (!activeAgent) throw new Error("Create an agent first");
      if (!activeAgent.modelId) throw new Error("Set the agent model");
      const selected = quasarRef.current.selectedIds;
      const targetIds = quasarRef.current.selectedDocuments
        .filter((document) => ["target", "investigation-target"].includes(document.dtype))
        .map((document) => document._id);
      const day = new Date().toISOString().slice(0, 10);
      const month = day.slice(0, 7);
      const dailySpent = costs
        .filter((cost) => cost.createdAt?.startsWith(day))
        .reduce((total, cost) => total + Number(cost.costUsd || 0), 0);
      const monthlySpent = costs
        .filter((cost) => cost.createdAt?.startsWith(month))
        .reduce((total, cost) => total + Number(cost.costUsd || 0), 0);
      const numericBudget = (value) =>
        value === undefined || value === null || value === ""
          ? Number.POSITIVE_INFINITY
          : Number(value);
      const availableCost = Math.min(
        numericBudget(activeAgent.budget?.maxCostUsd),
        Math.max(0, numericBudget(activeAgent.budget?.dailyCostUsd) - dailySpent),
        Math.max(0, numericBudget(activeAgent.budget?.monthlyCostUsd) - monthlySpent)
      );
      if (availableCost <= 0) throw new Error("Agent budget exhausted");
      const effectiveAgent = {
        ...activeAgent,
        budget: { ...activeAgent.budget, maxCostUsd: availableCost }
      };
      return supervisor.run(effectiveAgent, {
        goal,
        loopEnabled,
        selectionIds: selected,
        targetIds,
        dataset: activeDataset(quasarRef.current.documents, selected),
        graphId: quasarRef.current.activeGraph?.id || null
      });
    },
    [activeAgent, costs, supervisor]
  );

  const command = useCallback(
    async (input) => {
      const value = input.trim();
      if (!value) return null;
      if (value === "/pause") return activeRun && supervisor.pause(activeRun.id);
      if (value === "/resume") {
        if (!activeRun || !activeAgent) return null;
        return supervisor.run(activeAgent, { ...activeRun, status: "active", statusReason: "" });
      }
      if (value === "/stop") return activeRun && supervisor.stop(activeRun.id);
      if (value === "/retry") {
        if (!activeRun || !activeAgent) return null;
        return supervisor.run(activeAgent, {
          ...activeRun,
          status: "active",
          statusReason: "Retrying"
        });
      }
      if (value === "/clear") {
        setActiveRunId("");
        return null;
      }
      if (value === "/budget" || value === "/cost") {
        const usage = activeRun?.usage || {};
        const remaining = activeRun ? remainingBudget(activeRun.budget, usage) : null;
        quasarRef.current.setNotice({
          kind: "info",
          message: activeRun
            ? `$${Number(usage.costUsd || 0).toFixed(4)} used · $${Number(remaining.costUsd || 0).toFixed(4)} remaining`
            : "No run selected"
        });
        return activeRun;
      }
      if (value === "/tools") {
        quasarRef.current.setNotice({
          kind: "info",
          message: activeAgent
            ? toolRegistry
                .list(activeAgent)
                .map((tool) => tool.name)
                .join(" · ")
            : "No agent selected"
        });
        return null;
      }
      if (value === "/checkpoint") {
        if (!activeRun) return null;
        return supervisor.checkpoint(activeRun, "Manual checkpoint");
      }
      if (value === "/rollback") {
        if (!activeRun?.checkpointId) throw new Error("No checkpoint available");
        return supervisor.restoreCheckpoint(activeRun.id, activeRun.checkpointId);
      }
      if (value.startsWith("/run"))
        return runCommand(
          value.slice(4).trim() ||
            activeRun?.goal ||
            "Inspect the current context and choose the next useful action.",
          { loopEnabled: true }
        );
      return runCommand(value, { loopEnabled: false });
    },
    [activeAgent, activeRun, runCommand, supervisor, toolRegistry]
  );

  const value = useMemo(
    () => ({
      ready,
      agents,
      roles,
      providers,
      runs,
      memories,
      costs,
      skills,
      mcpServers,
      activeAgent,
      activeRun,
      activeAgentId,
      activeRunId,
      setActiveAgentId,
      setActiveRunId,
      refresh,
      command,
      supervisor,
      saveAgent: async (agent) => {
        const saved = await saveAgent(agent);
        await refresh();
        setActiveAgentId(saved.id);
        return saved;
      },
      removeAgent: async (id) => {
        await removeAgentRecord(AGENT_RECORD_TYPES.agent, id);
        if (activeAgentId === id) setActiveAgentId("");
        await refresh();
      },
      saveRole: async (role) => {
        const saved = await saveRole(role);
        await refresh();
        return saved;
      },
      removeRole: async (id) => {
        if (agents.some((agent) => agent.roleId === id))
          throw new Error("Role is assigned to an agent");
        await removeAgentRecord(AGENT_RECORD_TYPES.role, id);
        await refresh();
      },
      saveMemory: async (memory) => {
        const saved = await saveAgentRecord(
          {
            ...memory,
            recordType: AGENT_RECORD_TYPES.memory
          },
          AGENT_RECORD_TYPES.memory
        );
        await refresh();
        return saved;
      },
      saveSkill: async (skill) => {
        const saved = await saveAgentRecord(
          {
            ...skill,
            id: String(skill.id || "").trim(),
            name: String(skill.name || "").trim(),
            instructions: String(skill.instructions || "").trim(),
            toolNames: [...new Set((skill.toolNames || []).map(String))],
            enabled: skill.enabled !== false,
            recordType: AGENT_RECORD_TYPES.skill
          },
          AGENT_RECORD_TYPES.skill
        );
        await refresh();
        return saved;
      },
      removeSkill: async (id) => {
        await removeAgentRecord(AGENT_RECORD_TYPES.skill, id);
        await refresh();
      },
      saveMcpServer: async (server, secret) => {
        const saved = await saveAgentRecord(
          {
            ...server,
            id: String(server.id || "").trim(),
            name: String(server.name || "").trim(),
            url: String(server.url || "").trim(),
            allowedTools: [...new Set((server.allowedTools || []).map(String))],
            enabled: server.enabled !== false,
            recordType: AGENT_RECORD_TYPES.mcpServer
          },
          AGENT_RECORD_TYPES.mcpServer
        );
        if (secret) setProviderSecret(`mcp:${saved.id}`, secret, saved);
        await refresh();
        return saved;
      },
      removeMcpServer: async (id) => {
        await removeAgentRecord(AGENT_RECORD_TYPES.mcpServer, id);
        await refresh();
      },
      testMcpServer: (server, secret) =>
        testMcpServer(server, secret || getProviderSecret(`mcp:${server.id}`, server)),
      setBraveKey: (secret) => setProviderSecret("brave-search", secret),
      clearMemory: async (id) => {
        await removeAgentRecord(AGENT_RECORD_TYPES.memory, id);
        await refresh();
      },
      saveProvider: async (provider, secret) => {
        const normalized = normalizeProviderConfig(provider);
        const existing = await getAgentRecord(AGENT_RECORD_TYPES.provider, normalized.id);
        if (
          existing &&
          (existing.baseUrl !== normalized.baseUrl || existing.type !== normalized.type)
        ) {
          deleteProviderSecret(normalized.id);
        }
        const saved = await saveAgentRecord(
          {
            ...normalized,
            recordType: AGENT_RECORD_TYPES.provider
          },
          AGENT_RECORD_TYPES.provider
        );
        if (secret) setProviderSecret(saved.id, secret, saved);
        await refresh();
        return saved;
      },
      testProvider: (provider, secret) =>
        testProviderConnection(provider, secret || getProviderSecret(provider.id, provider)),
      hasProviderSecret,
      exportRecords: exportAgentSystemRecords,
      importRecords: async (payload, options) => {
        const result = await importAgentSystemRecords(payload, options);
        await refresh();
        return result;
      }
    }),
    [
      ready,
      agents,
      roles,
      providers,
      runs,
      memories,
      costs,
      skills,
      mcpServers,
      activeAgent,
      activeRun,
      activeAgentId,
      activeRunId,
      refresh,
      command,
      supervisor
    ]
  );

  return <AgentSystemContext.Provider value={value}>{children}</AgentSystemContext.Provider>;
}

export function useAgentSystem() {
  const value = useContext(AgentSystemContext);
  if (!value) throw new Error("useAgentSystem must be used inside AgentSystemProvider");
  return value;
}

function StatusDot({ status }) {
  return (
    <span
      className={`agent-status-dot agent-status-${status || "idle"}`}
      aria-label={status || "idle"}
    />
  );
}

function CostMeter({ run }) {
  const state = budgetState(run?.budget || {}, run?.usage || {});
  const ratio = Math.min(1, state.ratio || 0);
  return (
    <div className="agent-cost-meter" title={`${(run?.usage?.costUsd || 0).toFixed(4)} USD`}>
      <span style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function AgentBubble() {
  const { agents, activeAgent, activeRun, setActiveAgentId, command } = useAgentSystem();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [position, setPosition] = useState(loadBubblePosition);
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const active = activeRun?.status === "active";

  useEffect(() => {
    if (!dragging) return undefined;
    const move = (event) => {
      const x = Math.max(8, Math.min(window.innerWidth - 64, event.clientX - dragOffset.current.x));
      const y = Math.max(
        8,
        Math.min(window.innerHeight - 64, event.clientY - dragOffset.current.y)
      );
      setPosition({ dock: null, x, y });
    };
    const end = () => {
      setDragging(false);
      setPosition((current) => {
        const dock = current.x < 80 ? "left" : current.x > window.innerWidth - 140 ? "right" : null;
        const next = dock ? { dock, x: null, y: current.y } : current;
        localStorage.setItem(BUBBLE_POSITION_KEY, JSON.stringify(next));
        return next;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
  }, [dragging]);

  const style = position.dock
    ? { [position.dock]: "max(14px, env(safe-area-inset-right))", top: position.y || undefined }
    : { left: position.x, top: position.y };

  async function submit(event) {
    event.preventDefault();
    const value = input;
    setInput("");
    await command(value);
  }

  return (
    <div
      className={`agent-float agent-dock-${position.dock || "free"} ${open ? "open" : ""}`}
      style={style}
    >
      {open && (
        <section className="agent-compact-panel" aria-label="Agent command panel">
          <header>
            <div>
              <StatusDot status={activeRun?.status} />
              <strong>{activeAgent?.name || "No agent"}</strong>
            </div>
            <div>
              <Link
                className="icon-button"
                to="/agents?tab=run"
                title="Open chat"
                aria-label="Open chat"
                onClick={() => setOpen(false)}
              >
                <Expand size={16} />
              </Link>
              <button className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
                <X size={17} />
              </button>
            </div>
          </header>
          <div className="agent-compact-body">
            <label className="field">
              <span>Agent</span>
              <select
                value={activeAgent?.id || ""}
                onChange={(event) => setActiveAgentId(event.target.value)}
              >
                <option value="">Select agent</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            {activeRun ? (
              <div className="agent-run-summary">
                <strong>{activeRun.goal || "Run"}</strong>
                <span>
                  {activeRun.status}
                  {activeRun.statusReason ? ` · ${activeRun.statusReason}` : ""}
                </span>
                <CostMeter run={activeRun} />
                <small>
                  ${(activeRun.usage?.costUsd || 0).toFixed(4)} · {activeRun.usage?.toolCalls || 0}{" "}
                  tools · {activeRun.usage?.iterations || 0} iterations
                </small>
              </div>
            ) : (
              <p className="muted">No run selected.</p>
            )}
            <div className="agent-quick-actions">
              {active ? (
                <button className="button" onClick={() => command("/pause")}>
                  <Pause size={14} /> Pause
                </button>
              ) : (
                <button className="button" disabled={!activeRun} onClick={() => command("/resume")}>
                  <Play size={14} /> Resume
                </button>
              )}
              <button
                className="button danger"
                disabled={!activeRun}
                onClick={() => command("/stop")}
              >
                <Square size={13} /> Stop
              </button>
              <Link
                className="button primary agent-open-chat"
                to="/agents?tab=run"
                onClick={() => setOpen(false)}
              >
                <MessageSquareCode size={14} /> Open chat
              </Link>
            </div>
          </div>
          <form className="agent-command-input" onSubmit={submit}>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Command or /run"
              list="agent-slash-commands"
              autoComplete="off"
            />
            <datalist id="agent-slash-commands">
              {SLASH_COMMANDS.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
            <button className="icon-button primary" aria-label="Run">
              <Play size={16} />
            </button>
          </form>
        </section>
      )}
      <button
        className={`agent-bubble agent-status-${activeRun?.status || "idle"}`}
        onClick={() => !dragging && setOpen((value) => !value)}
        onPointerDown={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          dragOffset.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
          setDragging(true);
        }}
        title={active ? "Agent running" : "Open agent"}
        aria-expanded={open}
      >
        <GripVertical className="agent-grip" size={11} />
        <Bot size={24} />
        {active && <span className="agent-activity" />}
      </button>
    </div>
  );
}

function RunControls({ run }) {
  const { command } = useAgentSystem();
  if (!run) return null;
  return (
    <div className="button-row">
      {run.status === "active" ? (
        <button className="button" onClick={() => command("/pause")}>
          <Pause size={14} /> Pause
        </button>
      ) : (
        <button
          className="button"
          onClick={() => command("/resume")}
          disabled={!["paused", "failed", "completed"].includes(run.status)}
        >
          <Play size={14} /> Resume
        </button>
      )}
      <button
        className="button danger"
        onClick={() => command("/stop")}
        disabled={["stopped", "completed", "budget-exhausted"].includes(run.status)}
      >
        <Square size={13} /> Stop
      </button>
      <button className="button" onClick={() => command("/retry")}>
        <RotateCcw size={14} /> Retry
      </button>
    </div>
  );
}

function AgentEditor({ agent, roles, providers, skills, mcpServers, onSave, onDelete }) {
  const initial =
    agent ||
    defaultAgentInput(roles[0] || DEFAULT_ROLES[0], providers[0] || DEFAULT_PROVIDER_CONFIGS[0]);
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(agent || initial), [agent]);
  const togglePermission = (permission) => {
    setForm((current) => ({
      ...current,
      permissions: current.permissions?.includes(permission)
        ? current.permissions.filter((item) => item !== permission)
        : [...(current.permissions || []), permission]
    }));
  };
  return (
    <form
      className="agent-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(normalizeAgent(form));
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>ID</span>
          <input
            value={form.id}
            onChange={(event) => setForm({ ...form, id: event.target.value })}
            required
            disabled={Boolean(agent)}
          />
        </label>
        <label className="field">
          <span>Name</span>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
          />
        </label>
        <label className="field full">
          <span>Description</span>
          <input
            value={form.description || ""}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Role</span>
          <select
            value={form.roleId}
            onChange={(event) => {
              const role = roles.find((item) => item.id === event.target.value);
              setForm({
                ...form,
                roleId: event.target.value,
                permissions: role?.permissions || form.permissions
              });
            }}
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Provider</span>
          <select
            value={form.providerId}
            onChange={(event) => setForm({ ...form, providerId: event.target.value })}
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field full">
          <span>Model</span>
          <input
            value={form.modelId}
            onChange={(event) => setForm({ ...form, modelId: event.target.value })}
            placeholder="Provider model ID"
            required
          />
        </label>
        <label className="field full">
          <span>System prompt</span>
          <textarea
            value={form.systemPrompt || ""}
            onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
          />
        </label>
      </div>
      <fieldset className="agent-permissions">
        <legend>Tool permissions</legend>
        {AGENT_PERMISSIONS.map((permission) => (
          <label className="checkbox" key={permission}>
            <input
              type="checkbox"
              checked={form.permissions?.includes(permission)}
              onChange={() => togglePermission(permission)}
            />{" "}
            {permission}
          </label>
        ))}
      </fieldset>
      <fieldset className="agent-permissions">
        <legend>Skills</legend>
        {skills.map((skill) => (
          <label className="checkbox" key={skill.id}>
            <input
              type="checkbox"
              checked={form.skillIds?.includes(skill.id)}
              onChange={() =>
                setForm((current) => ({
                  ...current,
                  skillIds: current.skillIds?.includes(skill.id)
                    ? current.skillIds.filter((id) => id !== skill.id)
                    : [...(current.skillIds || []), skill.id]
                }))
              }
            />{" "}
            {skill.name}
          </label>
        ))}
      </fieldset>
      <fieldset className="agent-permissions">
        <legend>MCP servers</legend>
        {mcpServers.map((server) => (
          <label className="checkbox" key={server.id}>
            <input
              type="checkbox"
              checked={form.mcpServerIds?.includes(server.id)}
              onChange={() =>
                setForm((current) => ({
                  ...current,
                  mcpServerIds: current.mcpServerIds?.includes(server.id)
                    ? current.mcpServerIds.filter((id) => id !== server.id)
                    : [...(current.mcpServerIds || []), server.id]
                }))
              }
            />{" "}
            {server.name}
          </label>
        ))}
      </fieldset>
      <div className="form-grid">
        <label className="field">
          <span>Max cost (USD)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.budget?.maxCostUsd ?? 2}
            onChange={(event) =>
              setForm({
                ...form,
                budget: { ...form.budget, maxCostUsd: Number(event.target.value) }
              })
            }
          />
        </label>
        <label className="field">
          <span>Max iterations</span>
          <input
            type="number"
            min="1"
            value={form.loop?.maxIterations ?? 20}
            onChange={(event) =>
              setForm({
                ...form,
                loop: { ...form.loop, maxIterations: Number(event.target.value) },
                budget: { ...form.budget, maxIterations: Number(event.target.value) }
              })
            }
          />
        </label>
        <label className="field">
          <span>Max tool calls</span>
          <input
            type="number"
            min="1"
            value={form.loop?.maxToolCalls ?? 60}
            onChange={(event) =>
              setForm({
                ...form,
                loop: { ...form.loop, maxToolCalls: Number(event.target.value) },
                budget: { ...form.budget, maxToolCalls: Number(event.target.value) }
              })
            }
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.enabled !== false}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          />{" "}
          Enabled
        </label>
      </div>
      <div className="form-actions">
        {agent && (
          <button type="button" className="button danger" onClick={() => onDelete(agent.id)}>
            Delete
          </button>
        )}
        <button className="button primary">Save agent</button>
      </div>
    </form>
  );
}

function SkillEditor({ skill, onSave, onDelete }) {
  const [form, setForm] = useState(
    skill || {
      id: `skill-${crypto.randomUUID().slice(0, 8)}`,
      name: "New skill",
      description: "",
      instructions: "",
      toolNames: [],
      enabled: true
    }
  );
  return (
    <form
      className="agent-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(form);
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>ID</span>
          <input
            value={form.id}
            disabled={Boolean(skill)}
            onChange={(event) => setForm({ ...form, id: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Name</span>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label className="field full">
          <span>Description</span>
          <input
            value={form.description || ""}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </label>
        <label className="field full">
          <span>Instructions</span>
          <textarea
            className="code-editor"
            value={form.instructions || ""}
            onChange={(event) => setForm({ ...form, instructions: event.target.value })}
          />
        </label>
        <label className="field full">
          <span>Tool names</span>
          <input
            value={(form.toolNames || []).join(", ")}
            onChange={(event) =>
              setForm({
                ...form,
                toolNames: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean)
              })
            }
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.enabled !== false}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          />{" "}
          Enabled
        </label>
      </div>
      <div className="form-actions">
        {skill && (
          <button type="button" className="button danger" onClick={() => onDelete(skill.id)}>
            Delete
          </button>
        )}
        <button className="button primary">Save skill</button>
      </div>
    </form>
  );
}

function McpServerEditor({ server, onSave, onDelete, onTest }) {
  const [form, setForm] = useState(
    server || {
      id: `mcp-${crypto.randomUUID().slice(0, 8)}`,
      name: "MCP server",
      url: "",
      allowedTools: [],
      enabled: true
    }
  );
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState("");
  return (
    <form
      className="agent-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        await onSave(form, secret);
        setSecret("");
        setStatus("Saved");
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>ID</span>
          <input
            value={form.id}
            disabled={Boolean(server)}
            onChange={(event) => setForm({ ...form, id: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Name</span>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label className="field full">
          <span>Streamable HTTP URL</span>
          <input
            value={form.url}
            onChange={(event) => setForm({ ...form, url: event.target.value })}
            placeholder="https://mcp.example.org/mcp"
          />
        </label>
        <label className="field full">
          <span>Bearer token</span>
          <input
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="field full">
          <span>Allowed tools</span>
          <input
            value={(form.allowedTools || []).join(", ")}
            onChange={(event) =>
              setForm({
                ...form,
                allowedTools: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean)
              })
            }
            placeholder="Empty allows all listed tools"
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.enabled !== false}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          />{" "}
          Enabled
        </label>
      </div>
      <div className="form-actions">
        {status && <span className="muted">{status}</span>}
        {server && (
          <button type="button" className="button danger" onClick={() => onDelete(server.id)}>
            Delete
          </button>
        )}
        <button
          type="button"
          className="button"
          onClick={async () => {
            setStatus("Testing");
            try {
              const result = await onTest(form, secret);
              setStatus(`Connected · ${result.tools.length} tools`);
            } catch (error) {
              setStatus(error.message);
            }
          }}
        >
          Test
        </button>
        <button className="button primary">Save server</button>
      </div>
    </form>
  );
}

function WebToolsPanel({ onSaveKey }) {
  const [key, setKey] = useState("");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [result, setResult] = useState("");
  return (
    <section className="panel agent-editor">
      <div className="section-heading">
        <h2>Web tools</h2>
      </div>
      <div className="form-grid">
        <label className="field full">
          <span>Brave Search key</span>
          <input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoComplete="off"
          />
        </label>
      </div>
      <div className="button-row">
        <button
          className="button primary"
          onClick={() => {
            onSaveKey(key);
            setKey("");
            setResult("Brave key set for this session");
          }}
        >
          Save key
        </button>
      </div>
      <div className="form-grid">
        <label className="field full">
          <span>Test search</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="field full">
          <span>Test URL fetch</span>
          <input value={url} onChange={(event) => setUrl(event.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button
          className="button"
          onClick={async () =>
            setResult(
              JSON.stringify(
                await braveWebSearch(query, {
                  apiKey: getProviderSecret("brave-search"),
                  count: 5
                }),
                null,
                2
              )
            )
          }
        >
          Search
        </button>
        <button
          className="button"
          onClick={async () => setResult(JSON.stringify(await fetchUrlContent(url), null, 2))}
        >
          Fetch URL
        </button>
      </div>
      {result && <pre className="agent-web-result">{result}</pre>}
    </section>
  );
}

function ProviderEditor({ provider, onSave, onTest, secretSet }) {
  const [form, setForm] = useState(provider);
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    setForm(provider);
    setSecret("");
    setStatus("");
  }, [provider]);
  if (!form) return null;
  return (
    <form
      className="agent-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        await onSave(form, secret);
        setSecret("");
        setStatus("Saved");
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Type</span>
          <input value={form.type} disabled />
        </label>
        <label className="field full">
          <span>Base URL</span>
          <input
            value={form.baseUrl || ""}
            onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
          />
        </label>
        <label className="field full">
          <span>Key {secretSet ? "· set for this session" : ""}</span>
          <input
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={secretSet ? "Replace key" : "Enter key"}
            autoComplete="off"
          />
        </label>
      </div>
      <p className="muted">
        Keys stay in this browser session. Normal settings, graph, dataset, prompt, log, and agent
        exports exclude them.
      </p>
      <div className="form-actions">
        {status && <span className="muted">{status}</span>}
        <button
          type="button"
          className="button"
          onClick={async () => {
            setStatus("Testing");
            try {
              const result = await onTest(form, secret);
              setStatus(`Connected · ${result.modelCount} models`);
            } catch (error) {
              setStatus(error.message);
            }
          }}
        >
          Test connection
        </button>
        <button className="button primary">Save provider</button>
      </div>
    </form>
  );
}

function RoleEditor({ role, onSave, onDelete }) {
  const [form, setForm] = useState(
    role || {
      id: `role-${crypto.randomUUID().slice(0, 8)}`,
      name: "New role",
      instructions: "",
      permissions: ["documents.read", "graph.read"],
      actions: ["inspect"],
      accepts: ["*"],
      outputs: [],
      autonomy: "bounded",
      review: "mutations",
      retry: { maxAttempts: 3, backoffMs: 1_000 },
      budget: { maxCostUsd: 1, maxIterations: 12, maxToolCalls: 30, maxRuntimeMs: 600_000 }
    }
  );
  useEffect(() => {
    if (role) setForm(role);
  }, [role]);
  return (
    <form
      className="agent-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(form);
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>ID</span>
          <input
            value={form.id}
            disabled={Boolean(role)}
            onChange={(event) => setForm({ ...form, id: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Name</span>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label className="field full">
          <span>Instructions</span>
          <textarea
            value={form.instructions || ""}
            onChange={(event) => setForm({ ...form, instructions: event.target.value })}
          />
        </label>
        <label className="field full">
          <span>Actions</span>
          <input
            value={(form.actions || []).join(", ")}
            onChange={(event) =>
              setForm({
                ...form,
                actions: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean)
              })
            }
          />
        </label>
        <label className="field">
          <span>Accepted object types</span>
          <input
            value={(form.accepts || []).join(", ")}
            onChange={(event) =>
              setForm({
                ...form,
                accepts: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean)
              })
            }
          />
        </label>
        <label className="field">
          <span>Required output types</span>
          <input
            value={(form.outputs || []).join(", ")}
            onChange={(event) =>
              setForm({
                ...form,
                outputs: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean)
              })
            }
          />
        </label>
        <label className="field">
          <span>Maximum autonomy</span>
          <select
            value={form.autonomy || "bounded"}
            onChange={(event) => setForm({ ...form, autonomy: event.target.value })}
          >
            <option value="manual">manual</option>
            <option value="bounded">bounded</option>
            <option value="supervised">supervised</option>
          </select>
        </label>
        <label className="field">
          <span>Review</span>
          <select
            value={form.review || "mutations"}
            onChange={(event) => setForm({ ...form, review: event.target.value })}
          >
            <option value="always">always</option>
            <option value="mutations">mutations</option>
            <option value="destructive">destructive</option>
            <option value="none">none</option>
          </select>
        </label>
      </div>
      <fieldset className="agent-permissions">
        <legend>Allowed tools</legend>
        {AGENT_PERMISSIONS.map((permission) => (
          <label className="checkbox" key={permission}>
            <input
              type="checkbox"
              checked={form.permissions?.includes(permission)}
              onChange={() =>
                setForm((current) => ({
                  ...current,
                  permissions: current.permissions?.includes(permission)
                    ? current.permissions.filter((item) => item !== permission)
                    : [...(current.permissions || []), permission]
                }))
              }
            />{" "}
            {permission}
          </label>
        ))}
      </fieldset>
      <div className="form-actions">
        {role && onDelete && (
          <button type="button" className="button danger" onClick={() => onDelete(role.id)}>
            Delete
          </button>
        )}
        <button className="button primary">Save role</button>
      </div>
    </form>
  );
}

function MemoryEditor({ memory, agents, run, onSave, onClear }) {
  const initial = memory || {
    id: `memory-${crypto.randomUUID().slice(0, 8)}`,
    scope: "agent",
    scopeId: agents[0]?.id || "",
    summary: "",
    decisions: [],
    completedTasks: [],
    unresolvedLeads: [],
    instructions: []
  };
  const [form, setForm] = useState(initial);
  const listField = (field, label) => (
    <label className="field full">
      <span>{label}</span>
      <textarea
        value={(form[field] || []).join("\n")}
        onChange={(event) =>
          setForm({
            ...form,
            [field]: event.target.value
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean)
          })
        }
      />
    </label>
  );
  return (
    <form
      className="agent-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(form);
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>Scope</span>
          <select
            value={form.scope}
            onChange={(event) => setForm({ ...form, scope: event.target.value })}
          >
            <option value="run">run</option>
            <option value="agent">agent</option>
            <option value="target">target</option>
            <option value="dataset">dataset</option>
          </select>
        </label>
        <label className="field">
          <span>Scope ID</span>
          <input
            value={form.scopeId}
            onChange={(event) => setForm({ ...form, scopeId: event.target.value })}
            placeholder={form.scope === "run" ? run?.id : ""}
          />
        </label>
        <label className="field full">
          <span>Summary</span>
          <textarea
            value={form.summary || ""}
            onChange={(event) => setForm({ ...form, summary: event.target.value })}
          />
        </label>
        {listField("decisions", "Decisions")}
        {listField("completedTasks", "Completed tasks")}
        {listField("unresolvedLeads", "Unresolved leads")}
        {listField("instructions", "User instructions")}
      </div>
      <div className="form-actions">
        {memory && (
          <button type="button" className="button danger" onClick={() => onClear(memory.id)}>
            Clear scope
          </button>
        )}
        <button className="button primary">Save memory</button>
      </div>
    </form>
  );
}

function AgentChatPicker({ runs, activeRun, onSelect }) {
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => filterAgentChats(runs, query), [query, runs]);
  const activeLabel = activeRun?.goal || activeRun?.id || "No chat selected";

  useEffect(() => {
    if (!open) return undefined;
    searchRef.current?.focus();
    const close = (event) => {
      if (event.type === "keydown" && event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.type === "pointerdown" && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);

  function choose(runId) {
    onSelect(runId);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="agent-chat-picker" ref={rootRef}>
      <button
        className="agent-chat-picker-trigger"
        type="button"
        aria-label={`Other chats: ${activeLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="agent-chat-options"
        onClick={() => setOpen((value) => !value)}
      >
        <Search size={16} aria-hidden="true" />
        <span>
          <small>Other chats</small>
          <strong>{activeLabel}</strong>
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="agent-chat-picker-popover">
          <label className="agent-chat-picker-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              aria-label="Search chats"
              placeholder="Search chats"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div
            className="agent-chat-picker-options"
            id="agent-chat-options"
            role="listbox"
            aria-label="Other chats"
          >
            {matches.map((item) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={item.id === activeRun?.id}
                className={item.id === activeRun?.id ? "active" : ""}
                onClick={() => choose(item.id)}
              >
                <MessageSquareCode size={15} aria-hidden="true" />
                <span>
                  <strong>{item.goal || item.id}</strong>
                  <small>
                    {item.status || "idle"} · {item.agentId || item.id}
                  </small>
                </span>
              </button>
            ))}
            {!matches.length && <p className="muted">No chats found.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentConsole() {
  const system = useAgentSystem();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tab = AGENT_TABS.includes(requestedTab) ? requestedTab : "run";
  const [agentId, setAgentId] = useState(system.activeAgentId);
  const [providerId, setProviderId] = useState(system.providers[0]?.id || "");
  const [roleId, setRoleId] = useState(system.roles[0]?.id || "");
  const [roleDraft, setRoleDraft] = useState(null);
  const [memoryId, setMemoryId] = useState("");
  const [skillId, setSkillId] = useState("");
  const [mcpServerId, setMcpServerId] = useState("");
  const [commandText, setCommandText] = useState("");
  const run = system.activeRun;
  const agent = system.agents.find((item) => item.id === agentId) || null;
  const provider =
    system.providers.find((item) => item.id === providerId) || system.providers[0] || null;
  const role = system.roles.find((item) => item.id === roleId) || null;
  const memory = system.memories.find((item) => item.id === memoryId) || null;
  const skill = system.skills.find((item) => item.id === skillId) || null;
  const mcpServer = system.mcpServers.find((item) => item.id === mcpServerId) || null;
  const remaining = run ? remainingBudget(run.budget, run.usage) : null;
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const dailyCost = system.costs
    .filter((cost) => cost.createdAt?.startsWith(today))
    .reduce((total, cost) => total + Number(cost.costUsd || 0), 0);
  const monthlyCost = system.costs
    .filter((cost) => cost.createdAt?.startsWith(month))
    .reduce((total, cost) => total + Number(cost.costUsd || 0), 0);
  return (
    <section className="agent-console page-stack" data-tab={tab}>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Agent system</p>
          <h1>Operator console</h1>
        </div>
        <div className="button-row">
          <button
            className="button"
            onClick={async () => {
              const payload = await system.exportRecords();
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
              );
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = "quasar-agents.json";
              anchor.click();
              URL.revokeObjectURL(url);
            }}
          >
            Export JSON
          </button>
          <label className="button">
            Import JSON
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const result = await system.importRecords(JSON.parse(await file.text()));
                if (result.conflicts.length)
                  alert(`${result.conflicts.length} conflict(s); import not applied`);
                event.target.value = "";
              }}
            />
          </label>
          {run && (
            <div className="agent-console-status">
              <StatusDot status={run.status} />
              <strong>{run.status}</strong>
              <span>{run.statusReason}</span>
            </div>
          )}
        </div>
      </header>
      <nav className="agent-console-tabs">
        {AGENT_TABS.map((item) => (
          <button
            key={item}
            className={tab === item ? "active" : ""}
            onClick={() => setSearchParams({ tab: item }, { replace: true })}
          >
            {item}
          </button>
        ))}
      </nav>
      <label className="agent-console-tab-select">
        <span className="sr-only">Console section</span>
        <select
          value={tab}
          onChange={(event) => setSearchParams({ tab: event.target.value }, { replace: true })}
        >
          {AGENT_TABS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
      {tab === "run" && (
        <div className="agent-console-grid">
          <section className="panel agent-conversation">
            <div className="section-heading agent-conversation-heading">
              <h2>Conversation</h2>
              <div className="agent-conversation-actions">
                <AgentChatPicker
                  runs={system.runs}
                  activeRun={run}
                  onSelect={system.setActiveRunId}
                />
                <div className="agent-mobile-run-controls">
                  <RunControls run={run} />
                </div>
              </div>
            </div>
            <div className="agent-log">
              {run?.history?.map((entry) => (
                <article key={entry.id} className={`agent-log-entry ${entry.kind}`}>
                  <strong>{entry.kind === "tool" ? entry.name : "Agent"}</strong>
                  <pre>
                    {entry.error?.message ||
                      entry.text ||
                      JSON.stringify(entry.resultSummary, null, 2)}
                  </pre>
                </article>
              ))}
              {!run && <p className="muted">No run selected.</p>}
            </div>
            <form
              className="agent-console-command"
              onSubmit={async (event) => {
                event.preventDefault();
                const value = commandText;
                setCommandText("");
                await system.command(value);
              }}
            >
              <input
                value={commandText}
                onChange={(event) => setCommandText(event.target.value)}
                placeholder="Command or /run"
                list="agent-console-commands"
              />
              <datalist id="agent-console-commands">
                {SLASH_COMMANDS.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
              <button className="button primary">
                <Play size={14} /> Run
              </button>
            </form>
          </section>
          <aside className="agent-run-inspector">
            <section className="panel">
              <div className="section-heading">
                <h2>Control</h2>
              </div>
              <RunControls run={run} />
            </section>
            <section className="panel">
              <div className="section-heading">
                <h2>Scope</h2>
              </div>
              <dl>
                <dt>Goal</dt>
                <dd>{run?.goal || "—"}</dd>
                <dt>Target</dt>
                <dd>{run?.targetIds?.join(", ") || "—"}</dd>
                <dt>Dataset</dt>
                <dd>{run?.dataset || "—"}</dd>
                <dt>Graph</dt>
                <dd>{run?.graphId || "—"}</dd>
                <dt>Provider</dt>
                <dd>{run?.providerId || "—"}</dd>
                <dt>Model</dt>
                <dd>{run?.modelId || "—"}</dd>
              </dl>
            </section>
            <section className="panel">
              <div className="section-heading">
                <h2>Cost</h2>
                <CircleDollarSign size={18} />
              </div>
              {run && (
                <>
                  <CostMeter run={run} />
                  <dl>
                    <dt>Run cost</dt>
                    <dd>${run.usage.costUsd.toFixed(4)}</dd>
                    <dt>Daily total</dt>
                    <dd>${dailyCost.toFixed(4)}</dd>
                    <dt>Monthly total</dt>
                    <dd>${monthlyCost.toFixed(4)}</dd>
                    <dt>Input tokens</dt>
                    <dd>{run.usage.inputTokens}</dd>
                    <dt>Output tokens</dt>
                    <dd>{run.usage.outputTokens}</dd>
                    <dt>Cached tokens</dt>
                    <dd>{run.usage.cachedTokens}</dd>
                    <dt>Remaining</dt>
                    <dd>${remaining.costUsd.toFixed(4)}</dd>
                  </dl>
                </>
              )}
            </section>
            {run?.loopWarning && (
              <section className="panel agent-loop-warning">
                <h2>Loop paused</h2>
                <p>{run.loopWarning.message}</p>
                <ul>
                  {run.loopWarning.suggestedActions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      )}
      {tab === "agents" && (
        <div className="agent-management-grid">
          <aside className="panel agent-record-list">
            <button className={!agentId ? "active" : ""} onClick={() => setAgentId("")}>
              Create agent
            </button>
            {system.agents.map((item) => (
              <button
                className={agentId === item.id ? "active" : ""}
                key={item.id}
                onClick={() => setAgentId(item.id)}
              >
                <StatusDot status={item.enabled ? "idle" : "stopped"} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.id}</small>
                </span>
              </button>
            ))}
          </aside>
          <section className="panel">
            <AgentEditor
              key={agent?.id || "new"}
              agent={agent}
              roles={system.roles}
              providers={system.providers}
              skills={system.skills}
              mcpServers={system.mcpServers}
              onSave={system.saveAgent}
              onDelete={system.removeAgent}
            />
          </section>
        </div>
      )}
      {tab === "roles" && (
        <div className="agent-management-grid">
          <aside className="panel agent-record-list">
            <button
              className={!roleId && !roleDraft ? "active" : ""}
              onClick={() => {
                setRoleId("");
                setRoleDraft(null);
              }}
            >
              Create role
            </button>
            {system.roles.map((item) => (
              <button
                className={roleId === item.id ? "active" : ""}
                key={item.id}
                onClick={() => {
                  setRoleId(item.id);
                  setRoleDraft(null);
                }}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.id}</small>
                </span>
              </button>
            ))}
            {role && (
              <button
                onClick={() => {
                  setRoleId("");
                  setRoleDraft({
                    ...role,
                    id: `${role.id}-copy-${crypto.randomUUID().slice(0, 6)}`,
                    name: `${role.name} copy`,
                    _id: undefined,
                    createdAt: undefined,
                    updatedAt: undefined
                  });
                }}
              >
                Clone {role.name}
              </button>
            )}
          </aside>
          <section className="panel">
            <RoleEditor
              key={roleDraft?.id || role?.id || "new-role"}
              role={roleDraft || role}
              onSave={system.saveRole}
              onDelete={roleDraft ? undefined : system.removeRole}
            />
          </section>
        </div>
      )}
      {tab === "providers" && (
        <div className="agent-management-grid">
          <aside className="panel agent-record-list">
            {system.providers.map((item) => (
              <button
                className={provider?.id === item.id ? "active" : ""}
                key={item.id}
                onClick={() => setProviderId(item.id)}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.type}</small>
                </span>
              </button>
            ))}
          </aside>
          <section className="panel">
            <ProviderEditor
              provider={provider}
              onSave={system.saveProvider}
              onTest={system.testProvider}
              secretSet={provider && system.hasProviderSecret(provider.id, provider)}
            />
          </section>
        </div>
      )}
      {tab === "memory" && (
        <div className="agent-management-grid">
          <aside className="panel agent-record-list">
            <button className={!memoryId ? "active" : ""} onClick={() => setMemoryId("")}>
              Create memory
            </button>
            {system.memories.map((item) => (
              <button
                className={memoryId === item.id ? "active" : ""}
                key={item.id}
                onClick={() => setMemoryId(item.id)}
              >
                <span>
                  <strong>{item.scope}</strong>
                  <small>{item.scopeId}</small>
                </span>
              </button>
            ))}
          </aside>
          <section className="panel">
            <MemoryEditor
              key={memory?.id || "new-memory"}
              memory={memory}
              agents={system.agents}
              run={run}
              onSave={system.saveMemory}
              onClear={system.clearMemory}
            />
          </section>
        </div>
      )}
      {tab === "web" && <WebToolsPanel onSaveKey={system.setBraveKey} />}
      {tab === "skills" && (
        <div className="agent-management-grid">
          <aside className="panel agent-record-list">
            <button className={!skillId ? "active" : ""} onClick={() => setSkillId("")}>
              Create skill
            </button>
            {system.skills.map((item) => (
              <button
                className={skillId === item.id ? "active" : ""}
                key={item.id}
                onClick={() => setSkillId(item.id)}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.id}</small>
                </span>
              </button>
            ))}
          </aside>
          <section className="panel">
            <SkillEditor
              key={skill?.id || "new-skill"}
              skill={skill}
              onSave={system.saveSkill}
              onDelete={system.removeSkill}
            />
          </section>
        </div>
      )}
      {tab === "mcp" && (
        <div className="agent-management-grid">
          <aside className="panel agent-record-list">
            <button className={!mcpServerId ? "active" : ""} onClick={() => setMcpServerId("")}>
              Add server
            </button>
            {system.mcpServers.map((item) => (
              <button
                className={mcpServerId === item.id ? "active" : ""}
                key={item.id}
                onClick={() => setMcpServerId(item.id)}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.id}</small>
                </span>
              </button>
            ))}
          </aside>
          <section className="panel">
            <McpServerEditor
              key={mcpServer?.id || "new-mcp"}
              server={mcpServer}
              onSave={system.saveMcpServer}
              onDelete={system.removeMcpServer}
              onTest={system.testMcpServer}
            />
          </section>
        </div>
      )}
    </section>
  );
}
