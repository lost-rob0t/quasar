#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const repoRoot = new URL("../", import.meta.url).pathname;
let exitCode = 0;

function findOpenSsl() {
  try {
    const result = spawnSync("nix-store", ["-q", "--requisites", "/nix/var/nix/profiles/default"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.status === 0) {
      const lines = result.stdout.split("\n");
      for (const line of lines) {
        if (line.includes("openssl") && existsSync(`${line}/lib`)) {
          return `${line}/lib`;
        }
      }
    }
  } catch {
    // Nix not available, skip.
  }
  return null;
}

function childExitError(child, name) {
  if (child.exitCode !== null) {
    return new Error(`${name} exited before becoming healthy (code ${child.exitCode})`);
  }
  if (child.signalCode) {
    return new Error(`${name} exited before becoming healthy (signal ${child.signalCode})`);
  }
  return null;
}

function waitForHttp(url, timeoutMs, child) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const exited = childExitError(child, "development stack");
      if (exited) {
        reject(exited);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for ${url}`));
        return;
      }
      const curl = spawnSync("curl", ["-sf", "-o", "/dev/null", url], {
        encoding: "utf-8",
        timeout: 5000,
      });
      if (curl.status === 0) {
        resolve();
      } else {
        setTimeout(attempt, 500);
      }
    }
    attempt();
  });
}

function websocketExchange(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Origin: "http://127.0.0.1:5173" },
    });
    const received = new Set();
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket command exchange timed out"));
    }, 5_000);
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          protocol: "quasar.control.v1",
          id: "smoke-capabilities",
          command: "system.capabilities",
          payload: {},
          metadata: { client: "stack-smoke", workspace: "default" },
        }),
      );
      socket.send("{");
    });
    socket.on("message", (data) => {
      let response;
      try {
        response = JSON.parse(String(data));
      } catch {
        return;
      }
      if (response.id === "smoke-capabilities") {
        if (
          response.status !== "ok" ||
          !Array.isArray(response.result) ||
          !response.result.includes("workspace.snapshot") ||
          !response.result.includes("melissa.request") ||
          !response.result.includes("melissa.status")
        ) {
          reject(new Error("Invalid system.capabilities response"));
          socket.terminate();
          return;
        }
        received.add("capabilities");
      } else if (
        response.status === "error" &&
        response.error?.code === "protocol.invalid-envelope"
      ) {
        received.add("malformed");
      }
      if (received.size === 2) {
        clearTimeout(timer);
        socket.close();
        resolve();
      }
    });
    socket.on("error", reject);
  });
}

function waitForWs(url, timeoutMs, child) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    async function attempt() {
      const exited = childExitError(child, "development stack");
      if (exited) {
        reject(exited);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for WS ${url}`));
        return;
      }
      try {
        await websocketExchange(url);
        resolve();
      } catch {
        setTimeout(attempt, 500);
      }
    }
    attempt();
  });
}

async function runSmokeTest() {
  const opensslLib = findOpenSsl();
  const env = { ...process.env };
  if (opensslLib) {
    env.LD_LIBRARY_PATH = `${opensslLib}:${env.LD_LIBRARY_PATH ?? ""}`;
  }

  const marker = join(repoRoot, ".smoke-marker");
  writeFileSync(marker, "running");

  console.log("Starting dev stack for smoke test...");
  const dev = spawn("node", ["scripts/dev.mjs"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, SMOKE_TEST: "1" },
    shell: false,
    detached: process.platform !== "win32",
  });

  let stdout = "";
  let stderr = "";
  dev.stdout.on("data", (d) => {
    stdout += d;
  });
  dev.stderr.on("data", (d) => {
    stderr += d;
  });

  try {
    console.log("  waiting for Vite (http://127.0.0.1:5173)...");
    await waitForHttp("http://127.0.0.1:5173", 60000, dev);
    console.log("  Vite OK");

    console.log("  waiting for CLOG (http://127.0.0.1:8080)...");
    await waitForHttp("http://127.0.0.1:8080", 60000, dev);
    console.log("  CLOG OK");

    console.log("  waiting for WebSocket (ws://127.0.0.1:8081)...");
    await waitForWs("ws://127.0.0.1:8081", 60000, dev);
    console.log("  WebSocket OK");

    const exited = childExitError(dev, "development stack");
    if (exited) throw exited;
    console.log("\nSmoke test PASSED: all services started.");
  } catch (error) {
    console.error(`\nSmoke test FAILED: ${error.message}`);
    console.error("stdout:", stdout.slice(-4000));
    console.error("stderr:", stderr.slice(-4000));
    exitCode = 1;
  } finally {
    if (dev.pid) {
      try {
        process.kill(-dev.pid, "SIGTERM");
      } catch {
        dev.kill("SIGTERM");
      }
    }
    setTimeout(async () => {
      try {
        if (dev.pid) process.kill(-dev.pid, "SIGKILL");
      } catch {}
      try {
        unlinkSync(marker);
      } catch {}
      const alive = [];
      for (const url of ["http://127.0.0.1:5173", "http://127.0.0.1:8080"]) {
        try {
          await fetch(url);
          alive.push(url);
        } catch {}
      }
      if (alive.length) {
        console.error(`Smoke test FAILED: shutdown left services running: ${alive.join(", ")}`);
        exitCode = 1;
      }
      process.exit(exitCode);
    }, 5000);
  }
}

runSmokeTest();
