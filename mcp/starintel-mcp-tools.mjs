// StarIntel MCP tool table: pure mapping from MCP tool calls to control-plane
// commands. Read-only by design - the write ops never appear here. Kept free
// of I/O so the mapping is unit-testable without sockets.

export const SERVER_INFO = Object.freeze({ name: "starintel", version: "1.0.0" });
export const PROTOCOL_VERSION = "2025-03-26";

function serverConfig(args, defaults) {
  const url = String(args.server_url || defaults.starUrl || "").trim();
  const token = String(args.server_token || defaults.starToken || "").trim();
  const config = {};
  if (url) config.url = url;
  if (token) config.token = token;
  return config;
}

function relayOp(op, passthroughKeys) {
  return (args, defaults) => {
    const payload = { op, ...serverConfig(args, defaults) };
    for (const key of passthroughKeys) {
      const value = args[key];
      if (value !== undefined && value !== null && value !== "") payload[key] = value;
    }
    return { command: "starintel.api", payload };
  };
}

const boundedLimit = (args) => {
  const limit = Number(args.limit);
  return Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), 100) : undefined;
};

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "starintel_search",
    description:
      "Full-text search over every document on the StarIntel server. Returns bounded rows with ids, dtypes, and embedded documents.",
    inputSchema: {
      type: "object",
      required: ["q"],
      properties: {
        q: { type: "string", description: "Search query (server query syntax)" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        server_url: { type: "string" },
        server_token: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "starintel_stats",
    description: "Server totals: document count, per-dtype breakdown, target count.",
    inputSchema: {
      type: "object",
      properties: { server_url: { type: "string" }, server_token: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "starintel_recent_documents",
    description:
      "Newest-first listing of server documents (recents projection); usable without a query. Paginate with the returned next_start_key/next_start_key_doc_id.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        start_key: { type: "string", description: "JSON key cursor from a previous page" },
        start_key_doc_id: { type: "string" },
        server_url: { type: "string" },
        server_token: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "starintel_document",
    description: "Fetch one server document by id (v1 route with legacy fallback).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        server_url: { type: "string" },
        server_token: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "starintel_neighbors",
    description:
      "One-hop relations of a server document: compact relation tuples with neighbor ids, cursor-paged.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        bookmark: { type: "string" },
        server_url: { type: "string" },
        server_token: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "starintel_targets",
    description: "List accepted targets for a server actor.",
    inputSchema: {
      type: "object",
      required: ["actor"],
      properties: {
        actor: { type: "string" },
        server_url: { type: "string" },
        server_token: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "starintel_dataset_size",
    description: "Aggregate document count for one dataset on the server.",
    inputSchema: {
      type: "object",
      required: ["dataset"],
      properties: {
        dataset: { type: "string" },
        server_url: { type: "string" },
        server_token: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "workspace_search",
    description:
      "Search the LOCAL Quasar workspace documents (bounded pages, route-cached).",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        dtype: { type: "string" },
        dataset: { type: "string" },
        per_page: { type: "integer", minimum: 1, maximum: 250, description: "Page size (server-bounded)" }
      },
      additionalProperties: false
    }
  }
]);

function workspaceSearch(args) {
  const payload = {};
  if (args.q) payload.q = String(args.q).trim();
  if (args.dtype) payload.dtype = String(args.dtype).trim();
  if (args.dataset) payload.datasets = [String(args.dataset).trim()];
  if (args.per_page !== undefined && args.per_page !== null) payload.limit = Number(args.per_page);
  return { command: "document.search", payload };
}

const RELAY_TABLE = Object.freeze({
  starintel_search: relayOp("search", ["q"]),
  starintel_stats: relayOp("stats", []),
  starintel_recent_documents: relayOp("documents-recent", [
    "dataset",
    "start_key",
    "start_key_doc_id"
  ]),
  starintel_document: relayOp("document", ["id"]),
  starintel_neighbors: relayOp("neighbors", ["id", "bookmark"]),
  starintel_targets: relayOp("targets", ["actor"]),
  starintel_dataset_size: relayOp("dataset-size", ["dataset"])
});

/**
 * Map an MCP tools/call to a control-plane command.
 * Returns { command, payload } or null for unknown tools.
 */
export function resolveCommand(toolName, args = {}, defaults = {}) {
  if (toolName === "workspace_search") return workspaceSearch(args);
  const builder = RELAY_TABLE[toolName];
  if (!builder) return null;
  const call = builder(args, defaults);
  const limit = boundedLimit(args);
  if (limit !== undefined && toolName !== "starintel_targets") call.payload.limit = limit;
  return call;
}

/**
 * JSON-RPC dispatch over the MCP method surface. Resolves to a response
 * object for requests, null for notifications/unhandled batches. Pure with
 * respect to transport; `callTool(resolved)` reaches the control plane.
 */
export async function handleRpc(message, { callTool, state }) {
  if (!message || message.jsonrpc !== "2.0") return null;
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  const response = (result) =>
    isNotification ? null : { jsonrpc: "2.0", id, result };
  const fail = (code, messageText) =>
    isNotification ? null : { jsonrpc: "2.0", id, error: { code, message: messageText } };

  switch (method) {
    case "initialize":
      state.initialized = true;
      return response({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO }
      });
    case "notifications/initialized":
      return null;
    case "ping":
      return response({});
    case "tools/list":
      return response({
        tools: TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        }))
      });
    case "tools/call": {
      const name = String(params?.name || "");
      const args = params?.arguments || {};
      const resolved = resolveCommand(name, args, state.defaults || {});
      if (!resolved) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const result = await callTool(resolved);
        return response({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false
        });
      } catch (error) {
        return response({
          content: [{ type: "text", text: String(error?.message || error) }],
          isError: true
        });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}
