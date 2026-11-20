#!/usr/bin/env node
// Bundled StarIntel MCP server (streamable-HTTP JSON-RPC, zero dependencies).
//
// Exposes the StarIntel read surface (server search/stats/recents/document/
// neighbors/targets/dataset-size + local workspace search) as MCP tools so
// any MCP-capable agent can call them. Starts and stops with Quasar via
// scripts/run-control-plane; the agent system's MCP tab connects to it over
// HTTP like any other MCP server.
//
// Usage: node mcp/starintel-mcp-server.mjs [--port 8083] [--cp-url ws://127.0.0.1:8081]
//        [--star-url http://127.0.0.1:5000] [--star-token TOKEN]
// Env:   QUASAR_MCP_PORT, QUASAR_CP_URL, STAR_SERVER_URL, STAR_SERVER_TOKEN

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { handleRpc, SERVER_INFO } from "./starintel-mcp-tools.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    args[name] = value;
  }
  return args;
}

const options = parseArgs(process.argv.slice(2));
const PORT = Number(options.port || process.env.QUASAR_MCP_PORT || 8083);
const CP_URL = String(options["cp-url"] || process.env.QUASAR_CP_URL || "ws://127.0.0.1:8081");
const DEFAULTS = {
  starUrl: String(options["star-url"] || process.env.STAR_SERVER_URL || ""),
  starToken: String(options["star-token"] || process.env.STAR_SERVER_TOKEN || "")
};
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// --- Control-plane WebSocket (lazy, single shared connection) --------------

let ws = null;
let connecting = null;
let nextRequestId = 0;
const pending = new Map();

function cpDisconnect(reason) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(`Control plane connection lost (${reason}).`));
  }
  pending.clear();
  ws = null;
  connecting = null;
}

function cpConnect() {
  if (ws && ws.readyState === 1) return Promise.resolve(ws);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(CP_URL);
    } catch (error) {
      connecting = null;
      reject(new Error(`Control plane URL invalid: ${error.message}`));
      return;
    }
    socket.addEventListener("open", () => {
      ws = socket;
      connecting = null;
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      connecting = null;
      cpDisconnect("socket error");
      reject(new Error("Control plane unavailable."));
    });
    socket.addEventListener("close", () => {
      if (ws === socket) cpDisconnect("closed");
    });
    socket.addEventListener("message", (event) => {
      let data;
      try {
        const raw =
          typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        data = JSON.parse(raw);
      } catch {
        return;
      }
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.error) entry.reject(new Error(data.error.message || "Control plane error."));
      else entry.resolve(data.result);
    });
  });
  return connecting;
}

function cpSend(command, payload, timeoutMs = 30_000) {
  return cpConnect().then(
    (socket) =>
      new Promise((resolve, reject) => {
        const id = `mcp-${++nextRequestId}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Control plane command ${command} timed out.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(
          JSON.stringify({
            protocol: "quasar.control.v1",
            id,
            command,
            payload,
            metadata: { client: "starintel-mcp", workspace: "default" }
          })
        );
      })
  );
}

async function callTool(resolved) {
  const result = await cpSend(resolved.command, resolved.payload);
  if (result && typeof result === "object" && result.status === "error") {
    throw new Error(result.message || result.code || "StarIntel request failed.");
  }
  return result;
}

// --- MCP streamable-HTTP surface ------------------------------------------

const state = { defaults: DEFAULTS, initialized: false };

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "POST only" } });
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      json(res, 413, { jsonrpc: "2.0", error: { code: -32000, message: "Payload too large" } });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", async () => {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
      return;
    }
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    const responses = (
      await Promise.all(batch.map((message) => handleRpc(message, { callTool, state })))
    ).filter(Boolean);
    if (!responses.length) {
      res.writeHead(202);
      res.end();
      return;
    }
    const sessionHeaders =
      batch.some((message) => message.method === "initialize") && !state.sessionId
        ? (() => {
            state.sessionId = randomUUID();
            return { "Mcp-Session-Id": state.sessionId };
          })()
        : {};
    json(res, 200, Array.isArray(parsed) ? responses : responses[0], sessionHeaders);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`starintel-mcp: listening on http://127.0.0.1:${PORT}/mcp (cp ${CP_URL})`);
  console.log(`starintel-mcp: server ${SERVER_INFO.name} v${SERVER_INFO.version}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    cpDisconnect("shutdown");
    process.exit(0);
  });
}
