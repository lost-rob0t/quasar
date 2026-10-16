// Synthetic HTTP contract fixture, NOT StarIntel or proof of actor execution.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createDocument } from "starintel_doc";
const statePath = process.argv[2];
const records = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const loseResponses = Object.keys(records).length === 0;
const actor = {
  resourceUri: "star://fixture/actor/synthetic",
  resourceKind: "actor",
  semantic: { name: "synthetic", version: "1.0.0", digest: "sha256:fixture" },
  accepts: { targets: ["string"], documents: [], messages: [] },
  produces: { targets: [], documents: ["target"], messages: [] },
  capabilities: [],
  operatorVisible: true,
  provenance: { sourcePackage: "synthetic-test-fixture" },
  status: "online",
  ready: true,
  observedAt: "2026-10-16T00:00:00Z"
};
function save() {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(records));
  renameSync(`${statePath}.tmp`, statePath);
}
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5190");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  function json(body, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
  if (req.url === "/health") return json({ fixture: true });
  if (req.headers.authorization !== "Bearer synthetic-token")
    return json({ message: "denied" }, 401);
  if (req.url === "/v1/actors")
    return json({ data: { schema: "starintel-actor-registry-v1", count: 1, actors: [actor] } });
  if (req.url === "/api/v1/targets" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const command = JSON.parse(Buffer.concat(chunks).toString());
    if (!command.idempotency_key || !command.options || Array.isArray(command.options))
      return json({ message: "invalid command" }, 422);
    const previous = records[command.idempotency_key];
    if (previous) {
      if (loseResponses) {
        req.socket.destroy();
        return;
      }
      if (JSON.stringify(previous.command) !== JSON.stringify(command))
        return json({ message: "idempotency conflict" }, 409);
      return json({ ...previous.receipt, status: "duplicate" });
    }
    const id = `target:fixture-${Object.keys(records).length + 1}`;
    records[command.idempotency_key] = {
      command,
      receipt: { status: "accepted", target_id: id, request_id: `request:${id}` },
      document: createDocument("target", {
        id,
        actor: command.actor,
        target: command.target,
        dataset: command.dataset,
        options: command.options
      })
    };
    save();
    // The acceptance is durable but the first response is deliberately lost.
    req.socket.destroy();
    return;
  }
  if (req.url.startsWith("/api/v1/documents/")) {
    const id = decodeURIComponent(req.url.slice("/api/v1/documents/".length));
    const record = Object.values(records).find((entry) => entry.document.id === id);
    if (record) return json(record.document);
    if (id === "target:synthetic-output")
      return json(
        createDocument("target", {
          id,
          actor: "synthetic",
          target: "synthetic output document",
          dataset: "synthetic"
        })
      );
    return json({ message: "missing document" }, 404);
  }
  json({ message: "missing endpoint" }, 404);
});
server.listen(5191, "127.0.0.1");
