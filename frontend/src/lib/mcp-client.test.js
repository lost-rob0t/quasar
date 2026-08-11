import { afterEach, describe, expect, it, vi } from "vitest";
import { McpHttpClient, testMcpServer } from "./mcp-client";

afterEach(() => vi.restoreAllMocks());

describe("MCP HTTP client", () => {
  it("initializes, lists tools, and preserves the session", async () => {
    const responses = [
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-03-26", serverInfo: { name: "test" } }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "session-1" }
        }
      ),
      new Response("", { status: 202 }),
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { tools: [{ name: "search", inputSchema: {} }] }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift());
    const result = await testMcpServer({ id: "test", url: "https://mcp.example.org/mcp" }, "token");
    expect(result.tools[0].name).toBe("search");
    expect(fetch.mock.calls[2][1].headers["Mcp-Session-Id"]).toBe("session-1");
  });

  it("calls declared tools", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }] }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = new McpHttpClient({ id: "test", url: "https://mcp.example.org/mcp" });
    const result = await client.callTool("lookup", { id: "x" });
    expect(result.content[0].text).toBe("ok");
  });
});
