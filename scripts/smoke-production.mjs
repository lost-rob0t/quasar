#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import WebSocket from "ws";

const repoRoot = new URL("../", import.meta.url).pathname;
const executable = `${repoRoot}quasar-server`;

if (
  process.platform === "linux" &&
  !process.env.IN_NIX_SHELL &&
  !process.env.QUASAR_PRODUCTION_SMOKE_NIX_READY &&
  existsSync("/nix/store") &&
  existsSync(`${repoRoot}flake.nix`)
) {
  const nix = spawnSync("nix", ["--version"], { encoding: "utf-8", timeout: 5000 });
  if (nix.status === 0) {
    const result = spawnSync(
      "nix",
      [
        "develop",
        "-c",
        "env",
        "QUASAR_PRODUCTION_SMOKE_NIX_READY=1",
        "node",
        "scripts/smoke-production.mjs",
        ...process.argv.slice(2)
      ],
      { cwd: repoRoot, env: process.env, stdio: "inherit" }
    );
    if (result.error) {
      console.error(`[production-smoke] Unable to enter the Nix shell: ${result.error.message}`);
    }
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  throw new Error(message);
}

async function waitForPage(path, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:8080${path}`);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`Timed out waiting for production route ${path}`);
}

function rejectedHandshake(url, origin, expectedStatus) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: origin } });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Handshake did not return ${expectedStatus}`));
    }, 5_000);
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      if (response.statusCode === expectedStatus) resolve();
      else reject(new Error(`Expected handshake ${expectedStatus}, got ${response.statusCode}`));
    });
    socket.on("open", () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`Handshake unexpectedly succeeded; expected ${expectedStatus}`));
    });
    socket.on("error", () => {});
  });
}

function secureExchange(token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:8081?session=${encodeURIComponent(token)}`, {
      headers: { Origin: "http://127.0.0.1:8080" }
    });
    const responses = new Map();
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Secure WebSocket exchange timed out"));
    }, 8_000);
    socket.on("open", () => {
      const send = (id, command, payload = {}, workspace = "default") =>
        socket.send(
          JSON.stringify({
            protocol: "quasar.control.v1",
            id,
            command,
            payload,
            metadata: { client: "production-smoke", workspace }
          })
        );
      send("capabilities", "system.capabilities");
      send("starlang", "starlang.load", { source: "(error \"must not run\")" });
      send("workspace", "workspace.snapshot", {}, "unauthorized-workspace");
      socket.send("{");
      send("oversized", "workspace.snapshot", { padding: "x".repeat(1024 * 1024) });
    });
    socket.on("message", (data) => {
      const response = JSON.parse(String(data));
      responses.set(response.id || "malformed", response);
      if (responses.size < 5) return;
      clearTimeout(timer);
      socket.close();
      try {
        const capabilities = responses.get("capabilities");
        if (
          capabilities?.status !== "ok" ||
          !capabilities.result.includes("workspace.snapshot")
        )
          fail("Capabilities command failed");
        if (responses.get("starlang")?.error?.code !== "security.forbidden")
          fail("StarLang load was not capability-gated");
        if (responses.get("workspace")?.error?.code !== "security.forbidden")
          fail("Cross-workspace request was not rejected");
        if (responses.get("oversized")?.error?.code !== "protocol.invalid-envelope")
          fail("Oversized request was not rejected");
        if (responses.get("malformed")?.error?.code !== "protocol.invalid-envelope")
          fail(
            `Malformed input did not return the stable protocol error: ${JSON.stringify(
              responses.get("malformed")
            )}`
          );
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

function rateLimitExchange(token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:8081?session=${encodeURIComponent(token)}`, {
      headers: { Origin: "http://127.0.0.1:8080" }
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Rate limiter did not reject a burst"));
    }, 8_000);
    socket.on("open", () => {
      for (let index = 0; index < 110; index += 1) {
        socket.send(
          JSON.stringify({
            protocol: "quasar.control.v1",
            id: `rate-${index}`,
            command: "system.capabilities",
            payload: {},
            metadata: { client: "production-smoke", workspace: "default" }
          })
        );
      }
    });
    socket.on("message", (data) => {
      const response = JSON.parse(String(data));
      if (response.error?.code !== "security.rate-limited") return;
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.on("error", reject);
  });
}

if (!process.argv.includes("--skip-build")) {
  const build = spawnSync("bash", ["scripts/run-production", "--build-only"], {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
if (!existsSync(executable)) fail("quasar-server was not built");

const server = spawn(executable, [], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32"
});
let output = "";
server.stdout.on("data", (data) => (output += data));
server.stderr.on("data", (data) => (output += data));

try {
  const root = await waitForPage("/");
  const html = await root.text();
  const token = html.match(/name="quasar-session-token" content="([^"]+)"/)?.[1];
  if (!token || html.includes(token, html.indexOf("</head>") + 7)) fail("Session token missing");
  if (/rel=["']manifest["']/i.test(html)) fail("Lisp port must not advertise a web app manifest");
  if (/mobile-web-app-capable/i.test(html)) fail("Lisp port must not advertise app installation");
  const asset = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
  if (!asset) fail("Hashed production asset missing from index");
  const assetResponse = await waitForPage(asset);
  if (!/javascript|text\/css/.test(assetResponse.headers.get("content-type") || ""))
    fail("Production asset content type is incorrect");
  const nested = await waitForPage("/documents/production-smoke");
  if (!(await nested.text()).includes('<div id="root"></div>')) fail("Nested SPA route failed");

  await rejectedHandshake("ws://127.0.0.1:8081", "http://127.0.0.1:8080", 401);
  await rejectedHandshake(
    `ws://127.0.0.1:8081?session=${encodeURIComponent(token)}`,
    "https://untrusted.example",
    403
  );
  await secureExchange(token);
  await rateLimitExchange(token);
  console.log("Production build/serve/security smoke test passed.");
} catch (error) {
  console.error(error.message);
  console.error(output.slice(-4_000));
  process.exitCode = 1;
} finally {
  if (server.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 8_000))
  ]);
  if (server.exitCode === null && server.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {}
  }
  try {
    await fetch("http://127.0.0.1:8080");
    console.error("Production server did not release its HTTP port");
    process.exitCode = 1;
  } catch {}
}
