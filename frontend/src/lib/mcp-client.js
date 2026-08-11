function endpoint(value) {
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol))
    throw new TypeError("MCP URL must use HTTP or HTTPS");
  return url.href;
}

function parseSse(text) {
  for (const block of text.split(/\n\n+/)) {
    const data = block
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data) return JSON.parse(data);
  }
  throw new Error("MCP server returned no data");
}

export class McpHttpClient {
  constructor(config, secret = "") {
    this.config = { ...config, url: endpoint(config.url) };
    this.secret = secret;
    this.sessionId = "";
    this.requestId = 0;
  }

  async request(method, params = {}, { signal } = {}) {
    const response = await fetch(this.config.url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.secret ? { Authorization: `Bearer ${this.secret}` } : {}),
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...(this.config.headers || {})
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method,
        params
      })
    });
    if (!response.ok) throw new Error(`MCP request failed (${response.status})`);
    this.sessionId = response.headers.get("mcp-session-id") || this.sessionId;
    const text = await response.text();
    const data = response.headers.get("content-type")?.includes("text/event-stream")
      ? parseSse(text)
      : JSON.parse(text);
    if (data.error) throw new Error(data.error.message || "MCP server error");
    return data.result || {};
  }

  async initialize(options = {}) {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: this.config.protocolVersion || "2025-03-26",
        capabilities: {},
        clientInfo: { name: "quasar-ui", version: "0.1.0" }
      },
      options
    );
    await this.notify("notifications/initialized", {}, options);
    return result;
  }

  async notify(method, params = {}, { signal } = {}) {
    const response = await fetch(this.config.url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.secret ? { Authorization: `Bearer ${this.secret}` } : {}),
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...(this.config.headers || {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params })
    });
    if (!response.ok && response.status !== 202)
      throw new Error(`MCP notification failed (${response.status})`);
  }

  listTools(options) {
    return this.request("tools/list", {}, options).then((result) => result.tools || []);
  }

  callTool(name, args, options) {
    return this.request("tools/call", { name, arguments: args || {} }, options);
  }
}

export async function testMcpServer(config, secret = "", options = {}) {
  const client = new McpHttpClient(config, secret);
  const server = await client.initialize(options);
  const tools = await client.listTools(options);
  return {
    connected: true,
    server: server.serverInfo || null,
    protocolVersion: server.protocolVersion || null,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema || {}
    }))
  };
}
