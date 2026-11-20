import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_DEFINITIONS,
  SERVER_INFO,
  PROTOCOL_VERSION,
  resolveCommand,
  handleRpc
} from "./starintel-mcp-tools.mjs";

describe("resolveCommand", () => {
  it("maps search to the starintel.api relay op with bounded limit", () => {
    const resolved = resolveCommand("starintel_search", { q: "content:x", limit: 500 });
    assert.equal(resolved.command, "starintel.api");
    assert.deepEqual(resolved.payload, { op: "search", q: "content:x", limit: 100 });
  });

  it("strips unknown keys and defaults limit off", () => {
    const resolved = resolveCommand("starintel_recent_documents", {
      dataset: "reddit",
      evil: "payload"
    });
    assert.deepEqual(resolved.payload, { op: "documents-recent", dataset: "reddit" });
  });

  it("passes the resume cursor for recents paging", () => {
    const resolved = resolveCommand("starintel_recent_documents", {
      start_key: '["reddit",1710000000]',
      start_key_doc_id: "reddit:nk0g1vw",
      limit: 10
    });
    assert.equal(resolved.payload.start_key, '["reddit",1710000000]');
    assert.equal(resolved.payload.start_key_doc_id, "reddit:nk0g1vw");
    assert.equal(resolved.payload.limit, 10);
  });

  it("forwards per-call server config over defaults", () => {
    const resolved = resolveCommand(
      "starintel_document",
      { id: "doc-1", server_url: "http://other:5000", server_token: "t" },
      { starUrl: "http://default:5000" }
    );
    assert.deepEqual(resolved.payload, {
      op: "document",
      url: "http://other:5000",
      token: "t",
      id: "doc-1"
    });
  });

  it("uses configured default server config", () => {
    const resolved = resolveCommand(
      "starintel_stats",
      {},
      { starUrl: "http://s:5000", starToken: "k" }
    );
    assert.deepEqual(resolved.payload, { op: "stats", url: "http://s:5000", token: "k" });
  });

  it("maps workspace_search to document.search and rejects unknown tools", () => {
    assert.deepEqual(resolveCommand("workspace_search", { q: "person", per_page: 10 }), {
      command: "document.search",
      payload: { q: "person", limit: 10 }
    });
    assert.deepEqual(resolveCommand("workspace_search", { dataset: "reddit" }), {
      command: "document.search",
      payload: { datasets: ["reddit"] }
    });
    assert.equal(resolveCommand("write_everything", {}), null);
    assert.equal(resolveCommand("workspace_purge", {}), null);
  });
});

describe("handleRpc", () => {
  const ctx = { callTool: async () => ({ ok: true }), state: { defaults: {} } };

  it("initializes with tool capabilities and server info", async () => {
    const response = await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      ctx
    );
    assert.equal(response.result.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(response.result.serverInfo, SERVER_INFO);
    assert.ok(response.result.capabilities.tools);
  });

  it("lists the read-only tool surface", async () => {
    const response = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx);
    const names = response.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("starintel_search"));
    assert.ok(names.includes("starintel_recent_documents"));
    assert.ok(names.includes("workspace_search"));
    assert.equal(names.length, TOOL_DEFINITIONS.length);
    for (const tool of response.result.tools) {
      assert.ok(!tool.name.startsWith("workspace_purge"));
    }
  });

  it("executes tools/call through callTool and returns text content", async () => {
    let seen;
    const response = await handleRpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "starintel_search", arguments: { q: "x" } }
      },
      {
        ...ctx,
        callTool: async (resolved) => {
          seen = resolved;
          return { rows: [] };
        }
      }
    );
    assert.equal(seen.command, "starintel.api");
    assert.equal(response.result.isError, false);
    assert.deepEqual(JSON.parse(response.result.content[0].text), { rows: [] });
  });

  it("reports tool failures as isError content, not protocol errors", async () => {
    const response = await handleRpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "starintel_stats", arguments: {} }
      },
      {
        ...ctx,
        callTool: async () => {
          throw new Error("server down");
        }
      }
    );
    assert.equal(response.result.isError, true);
    assert.ok(response.result.content[0].text.includes("server down"));
  });

  it("rejects unknown tools with a protocol error", async () => {
    const response = await handleRpc(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } },
      ctx
    );
    assert.equal(response.error.code, -32602);
  });

  it("treats notifications as fire-and-forget", async () => {
    const response = await handleRpc(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ctx
    );
    assert.equal(response, null);
  });

  it("answers unknown methods with -32601", async () => {
    const response = await handleRpc({ jsonrpc: "2.0", id: 6, method: "resources/list" }, ctx);
    assert.equal(response.error.code, -32601);
  });
});
