import { buildGraph, findPaths } from "./graph";

const MAX_QUERY_RESULTS = 100;
const MAX_GRAPH_DEPTH = 4;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`Expected an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function text(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function documentMatches(document, query) {
  if (query.ids?.length && !query.ids.includes(document._id)) return false;
  if (query.objectTypes?.length && !query.objectTypes.includes(document.dtype)) return false;
  if (query.datasets?.length && !query.datasets.includes(document.dataset)) return false;
  if (
    query.targetIds?.length &&
    !query.targetIds.some((id) => document._id === id || document.related_ids?.includes(id))
  )
    return false;
  if (query.verificationStates?.length) {
    const state =
      document.verification?.status ||
      (document.verification?.verified ? "verified" : "unverified");
    if (!query.verificationStates.includes(state)) return false;
  }
  const needle = text(query.text);
  if (!needle) return true;
  return [
    document._id,
    document.title,
    document.summary,
    document.dtype,
    document.dataset,
    JSON.stringify(document.data || {}),
    JSON.stringify(document.sources || [])
  ].some((value) => text(value).includes(needle));
}

function documentSummary(document) {
  return {
    id: document._id,
    objectType: document.dtype,
    dataset: document.dataset,
    title: document.title || document.data?.name || document._id,
    summary: document.summary || "",
    verificationState:
      document.verification?.status ||
      (document.verification?.verified ? "verified" : "unverified"),
    sourceCount: document.sources?.length || 0,
    relation:
      document.dtype === "relation"
        ? {
            source: document.data?.subject || document.data?.source || null,
            predicate: document.data?.predicate || document.data?.relation_type || null,
            target: document.data?.object || document.data?.target || null,
            directed: document.data?.directed !== false
          }
        : null
  };
}

function graphNeighbors(graph, startIds, depth) {
  const visited = new Set(startIds);
  let frontier = new Set(startIds);
  const edges = [];
  for (let level = 0; level < depth && frontier.size; level += 1) {
    const next = new Set();
    for (const edge of graph.edges) {
      if (!frontier.has(edge.data.source) && !frontier.has(edge.data.target)) continue;
      edges.push(edge);
      const other = frontier.has(edge.data.source) ? edge.data.target : edge.data.source;
      if (!visited.has(other)) {
        visited.add(other);
        next.add(other);
      }
    }
    frontier = next;
  }
  return {
    nodeIds: [...visited],
    edges: [...new Map(edges.map((edge) => [edge.data.id, edge])).values()]
  };
}

export function assertToolPermission(agent, permission, { destructive = false } = {}) {
  const permissions = new Set(agent.permissions || []);
  if (!permissions.has(permission)) {
    const error = new Error(`Permission denied: ${permission}`);
    error.code = "permission_denied";
    throw error;
  }
  if (destructive && !permissions.has("destructive")) {
    const error = new Error("Destructive operation requires approval");
    error.code = "approval_required";
    error.approval = { permission: "destructive" };
    throw error;
  }
}

export function createAgentToolRegistry(environment) {
  const tools = new Map();
  const define = (tool) => {
    if (tools.has(tool.name)) throw new Error(`Duplicate agent tool: ${tool.name}`);
    tools.set(tool.name, Object.freeze(tool));
  };

  define({
    name: "query_database",
    description:
      "Query the scoped StarIntel document database. Returns bounded document summaries.",
    permission: "documents.read",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
        objectTypes: { type: "array", items: { type: "string" } },
        datasets: { type: "array", items: { type: "string" } },
        targetIds: { type: "array", items: { type: "string" } },
        verificationStates: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: 1, maximum: MAX_QUERY_RESULTS },
        includeDocuments: { type: "boolean" }
      },
      additionalProperties: false
    },
    async execute(args, context) {
      const limit = boundedInteger(args.limit, 25, 1, MAX_QUERY_RESULTS);
      const allowedDatasets = new Set(context.agent.datasetAccess || ["*"]);
      const documents = (await environment.getDocuments())
        .filter((document) => allowedDatasets.has("*") || allowedDatasets.has(document.dataset))
        .filter((document) => documentMatches(document, args))
        .slice(0, limit);
      return {
        count: documents.length,
        truncated: documents.length === limit,
        documents: args.includeDocuments ? documents : documents.map(documentSummary)
      };
    }
  });

  define({
    name: "query_graph",
    description:
      "Query the active graph by nodes, neighbors, predicate, path, dataset, or object type.",
    permission: "graph.read",
    parameters: {
      type: "object",
      properties: {
        nodeIds: { type: "array", items: { type: "string" } },
        depth: { type: "integer", minimum: 0, maximum: MAX_GRAPH_DEPTH },
        predicate: { type: "string" },
        objectType: { type: "string" },
        dataset: { type: "string" },
        pathFrom: { type: "string" },
        pathTo: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_QUERY_RESULTS }
      },
      additionalProperties: false
    },
    async execute(args) {
      const documents = await environment.getGraphDocuments();
      const graph = buildGraph(documents, environment.getPositions?.() || {});
      if (args.pathFrom && args.pathTo) {
        return {
          paths: findPaths(graph, args.pathFrom, args.pathTo, 5, MAX_GRAPH_DEPTH).map((path) => ({
            nodeIds: path.nodes,
            relationIds: path.edges.map((edge) => edge.data.relationId).filter(Boolean),
            predicates: path.edges.map((edge) => edge.data.predicate),
            cost: path.cost
          }))
        };
      }
      const depth = boundedInteger(args.depth, 1, 0, MAX_GRAPH_DEPTH);
      const neighborhood = args.nodeIds?.length
        ? graphNeighbors(graph, args.nodeIds, depth)
        : { nodeIds: graph.nodes.map((node) => node.data.id), edges: graph.edges };
      const nodes = graph.nodes
        .filter((node) => neighborhood.nodeIds.includes(node.data.id))
        .filter((node) => !args.objectType || node.data.dtype === args.objectType)
        .filter((node) => !args.dataset || node.data.dataset === args.dataset)
        .slice(0, boundedInteger(args.limit, 50, 1, MAX_QUERY_RESULTS));
      const nodeIds = new Set(nodes.map((node) => node.data.id));
      const edges = neighborhood.edges
        .filter((edge) => nodeIds.has(edge.data.source) && nodeIds.has(edge.data.target))
        .filter((edge) => !args.predicate || edge.data.predicate === args.predicate)
        .slice(0, MAX_QUERY_RESULTS);
      return {
        nodes: nodes.map((node) => ({
          id: node.data.id,
          label: node.data.label,
          objectType: node.data.dtype,
          dataset: node.data.dataset,
          verificationState: node.data.reviewState
        })),
        edges: edges.map((edge) => ({
          id: edge.data.relationId || edge.data.id,
          source: edge.data.source,
          predicate: edge.data.predicate,
          target: edge.data.target,
          directed: edge.data.directed,
          confidence: edge.data.confidence
        }))
      };
    }
  });

  define({
    name: "run_actor",
    description: "Run an existing Quasar actor against the current scoped selection.",
    permission: "actors.run",
    parameters: {
      type: "object",
      required: ["actorId"],
      properties: {
        actorId: { type: "string" },
        selectionIds: { type: "array", items: { type: "string" } }
      },
      additionalProperties: false
    },
    async execute(args, context) {
      const allowed = new Set(context.agent.actorAccess || ["*"]);
      if (!allowed.has("*") && !allowed.has(args.actorId))
        throw new Error(`Actor access denied: ${args.actorId}`);
      return environment.runActor(args.actorId, args.selectionIds || context.selectionIds || []);
    }
  });

  define({
    name: "web_search",
    description: "Search the public web with Brave Search and return bounded source results.",
    permission: "sources.external",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        count: { type: "integer", minimum: 1, maximum: 20 },
        country: { type: "string" },
        freshness: { type: "string" }
      },
      additionalProperties: false
    },
    execute(args, context) {
      return environment.webSearch(args, context);
    }
  });

  define({
    name: "fetch_url",
    description: "Fetch and extract bounded public URL content for inspection and sourcing.",
    permission: "sources.external",
    parameters: {
      type: "object",
      required: ["url"],
      properties: { url: { type: "string" } },
      additionalProperties: false
    },
    execute(args, context) {
      return environment.fetchUrl(args.url, context);
    }
  });

  define({
    name: "scrape_website",
    description: "Crawl and extract a bounded public website. Same-origin crawling is the default.",
    permission: "sources.external",
    parameters: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        maxPages: { type: "integer", minimum: 1, maximum: 20 },
        maxDepth: { type: "integer", minimum: 0, maximum: 2 },
        sameOrigin: { type: "boolean" }
      },
      additionalProperties: false
    },
    execute(args, context) {
      return environment.scrapeWebsite(args, context);
    }
  });

  define({
    name: "mcp_call",
    description: "Call an allowed tool on a configured remote MCP server.",
    permission: "server.use",
    parameters: {
      type: "object",
      required: ["serverId", "toolName"],
      properties: {
        serverId: { type: "string" },
        toolName: { type: "string" },
        arguments: { type: "object" }
      },
      additionalProperties: false
    },
    execute(args, context) {
      return environment.callMcp(args.serverId, args.toolName, args.arguments || {}, context);
    }
  });

  define({
    name: "build_graph",
    description:
      "Create and populate a named custom graph from document IDs or a bounded database query.",
    permission: "graph.edit",
    parameters: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        documentIds: { type: "array", items: { type: "string" }, maxItems: 500 },
        query: {
          type: "object",
          properties: {
            text: { type: "string" },
            objectTypes: { type: "array", items: { type: "string" } },
            datasets: { type: "array", items: { type: "string" } }
          }
        },
        layout: { type: "string" },
        includeRelations: { type: "boolean" }
      },
      additionalProperties: false
    },
    execute(args, context) {
      return environment.buildCustomGraph(args, context);
    }
  });

  define({
    name: "propose_graph_operations",
    description:
      "Validate and preview declared graph operations. Applying the preview is a separate approved action.",
    permission: "graph.edit",
    parameters: {
      type: "object",
      required: ["operations"],
      properties: {
        operations: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            required: ["op"],
            properties: {
              op: { type: "string" },
              document: { type: "object" },
              id: { type: "string" },
              source: { type: "string" },
              target: { type: "string" },
              predicate: { type: "string" },
              position: { type: "object" },
              graphId: { type: "string" }
            }
          }
        }
      },
      additionalProperties: false
    },
    async execute(args, context) {
      return environment.previewGraphOperations(args.operations, context);
    }
  });

  define({
    name: "apply_graph_operations",
    description: "Apply a validated graph-operation preview through Quasar history and undo.",
    permission: "graph.edit",
    parameters: {
      type: "object",
      required: ["operations"],
      properties: {
        operations: { type: "array", maxItems: 100, items: { type: "object" } },
        approvalToken: { type: "string" }
      },
      additionalProperties: false
    },
    async execute(args, context) {
      return environment.applyGraphOperations(args.operations, {
        ...context,
        approvalToken: args.approvalToken || ""
      });
    }
  });

  define({
    name: "validate_actor",
    description:
      "Validate generated actor source and test it against scoped sample documents without saving it.",
    permission: "actors.create",
    parameters: {
      type: "object",
      required: ["actor"],
      properties: {
        actor: { type: "object" },
        sampleDocumentIds: { type: "array", items: { type: "string" } }
      },
      additionalProperties: false
    },
    async execute(args, context) {
      return environment.validateActor(
        args.actor,
        args.sampleDocumentIds || context.selectionIds || [],
        context
      );
    }
  });

  define({
    name: "save_actor",
    description: "Save an actor candidate only after its validation and worker test succeeded.",
    permission: "actors.create",
    parameters: {
      type: "object",
      required: ["candidateId"],
      properties: { candidateId: { type: "string" } },
      additionalProperties: false
    },
    async execute(args, context) {
      return environment.saveValidatedActor(args.candidateId, context);
    }
  });

  return {
    list(agent) {
      const permissions = new Set(agent.permissions || []);
      return [...tools.values()].filter((tool) => permissions.has(tool.permission));
    },
    modelDefinitions(agent) {
      return this.list(agent).map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
    },
    async execute(name, args, context) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      assertToolPermission(context.agent, tool.permission, { destructive: tool.destructive });
      return tool.execute(args || {}, context);
    }
  };
}

export const AGENT_QUERY_ENGINE = Object.freeze({
  id: "javascript",
  version: 1,
  capabilities: ["documents", "graph", "paths"],
  futureAdapters: ["wasm-prolog"]
});
