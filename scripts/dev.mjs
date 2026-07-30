#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

const repoRoot = new URL("../", import.meta.url).pathname;
const frontendDir = `${repoRoot}frontend`;

const processes = [];
let exiting = false;
const emitter = new EventEmitter();

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

function startProcess(name, command, args, options = {}) {
  const proc = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      ...options.env,
    },
    shell: false,
  });
  processes.push({ name, proc });

  proc.stdout.on("data", (data) => {
    process.stdout.write(`[${name}] ${data}`);
  });
  proc.stderr.on("data", (data) => {
    process.stderr.write(`[${name}] ${data}`);
  });

  proc.on("exit", (code, signal) => {
    if (exiting) return;
    if (code !== null && code !== 0) {
      console.error(`\n[${name}] exited with code ${code}`);
    } else if (signal) {
      console.error(`\n[${name}] killed by signal ${signal}`);
    }
    shutdown(1);
  });

  return proc;
}

function shutdown(exitCode = 0) {
  if (exiting) return;
  exiting = true;
  console.log("\nShutting down all services...");

  for (const { name, proc } of processes) {
    if (!proc.killed) {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        try {
          proc.kill("SIGTERM");
        } catch {
          // Already dead.
        }
      }
      console.log(`  terminating ${name} (pid ${proc.pid})`);
    }
  }

  setTimeout(() => {
    for (const { name, proc } of processes) {
      if (!proc.killed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already dead.
        }
      }
    }
    process.exit(exitCode);
  }, 3000);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const opensslLib = findOpenSsl();
const env = { ...process.env };
if (opensslLib) {
  env.LD_LIBRARY_PATH = `${opensslLib}:${env.LD_LIBRARY_PATH ?? ""}`;
}

console.log("Starting Quasar development stack...");
console.log(`  repository: ${repoRoot}`);

// Start the Lisp control plane + WebSocket server + CLOG host
startProcess(
  "control-plane",
  "sbcl",
  [
    "--non-interactive",
    "--eval", "(setf asdf:*central-registry* nil)",
    "--eval", "(asdf:clear-configuration)",
    "--eval", "(ql:quickload (list :jsown :sento :bordeaux-threads :clog :websocket-driver) :silent t)",
    "--eval", "(asdf:load-asd (truename \"systems/quasar-control.asd\"))",
    "--eval", "(asdf:load-asd (truename \"systems/quasar-starlang.asd\"))",
    "--eval", "(asdf:load-asd (truename \"systems/quasar-web.asd\"))",
    "--eval", "(asdf:load-system :quasar-web)",
    "--eval", "(quasar.app:start :open-browser-p nil)",
  ],
  { env }
);

// Start the Vite dev server
startProcess(
  "vite",
  "npx",
  ["vite", "--port", "5173", "--host"],
  { cwd: frontendDir, env }
);

console.log("\n  control-plane: ws://127.0.0.1:8081  (WebSocket)");
console.log("  control-plane: http://127.0.0.1:8080 (CLOG host)");
console.log("  vite:          http://127.0.0.1:5173  (React UI)\n");
