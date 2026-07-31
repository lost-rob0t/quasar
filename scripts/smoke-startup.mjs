#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../", import.meta.url).pathname;
const frontendDir = join(repoRoot, "frontend");
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

function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
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

function waitForWs(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for WS ${url}`));
        return;
      }
      const script = `
        import('ws').then(({ default: WebSocket }) => {
          const ws = new WebSocket('${url}');
          const timer = setTimeout(() => { ws.close(); throw new Error('ws timeout'); }, 3000);
          ws.on('open', () => { clearTimeout(timer); ws.close(); process.exit(0); });
          ws.on('error', () => { process.exit(1); });
        }).catch(() => process.exit(1));
      `;
      const result = spawnSync("node", ["--input-type=module", "-e", script], {
        encoding: "utf-8",
        timeout: 5000,
        cwd: frontendDir,
      });
      if (result.status === 0) {
        resolve();
      } else {
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
  });

  let stdout = "";
  let stderr = "";
  dev.stdout.on("data", (d) => { stdout += d; });
  dev.stderr.on("data", (d) => { stderr += d; });

  try {
    console.log("  waiting for Vite (http://127.0.0.1:5173)...");
    await waitForHttp("http://127.0.0.1:5173", 30000);
    console.log("  Vite OK");

    console.log("  waiting for CLOG (http://127.0.0.1:8080)...");
    await waitForHttp("http://127.0.0.1:8080", 30000);
    console.log("  CLOG OK");

    console.log("  waiting for WebSocket (ws://127.0.0.1:8081)...");
    await waitForWs("ws://127.0.0.1:8081", 30000);
    console.log("  WebSocket OK");

    console.log("\nSmoke test PASSED: all services started.");
  } catch (error) {
    console.error(`\nSmoke test FAILED: ${error.message}`);
    console.error("stdout:", stdout.slice(-2000));
    console.error("stderr:", stderr.slice(-2000));
    exitCode = 1;
  } finally {
    dev.kill("SIGTERM");
    setTimeout(() => {
      try { dev.kill("SIGKILL"); } catch {}
      try { unlinkSync(marker); } catch {}
      process.exit(exitCode);
    }, 5000);
  }
}

runSmokeTest();
