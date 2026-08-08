#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const repoRoot = new URL("../", import.meta.url).pathname;
const frontendDir = join(repoRoot, "frontend");
const rootNodeModules = join(repoRoot, "node_modules");
const requireFromFrontend = createRequire(join(frontendDir, "package.json"));

const processes = [];
let exiting = false;
const emitter = new EventEmitter();

function fail(msg) {
  console.error(`\n[dev] ${msg}`);
  process.exit(1);
}

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

function resolveFromFrontend(spec) {
  try {
    return requireFromFrontend.resolve(spec);
  } catch {
    return null;
  }
}

function validateDependencies() {
  // Root node_modules must exist (npm ci installs the workspace root here).
  if (!existsSync(rootNodeModules)) {
    fail(`Missing root node_modules (${rootNodeModules}).\n  Run: npm ci`);
  }

  // Vite and the React plugin must be resolvable from the frontend package.
  // With npm workspaces they are typically hoisted into the root node_modules,
  // so resolve via Node's module resolution rather than assuming a path. Use the
  // bare specifier (not a /package.json subpath) because some packages restrict
  // their "exports" map and do not expose ./package.json.
  const resolvable = ["vite", "@vitejs/plugin-react"];
  for (const label of resolvable) {
    const found = resolveFromFrontend(label);
    if (!found) {
      fail(
        `Missing required dependency: ${label}.\n` +
          `  Could not resolve "${label}" from ${frontendDir}.\n` +
          `  Run: npm ci`,
      );
    }
  }

  if (!existsSync(join(frontendDir, "package.json"))) {
    fail(`frontend/package.json not found at ${frontendDir}.`);
  }

  if (!existsSync(join(repoRoot, "package-lock.json"))) {
    fail(`Root package-lock.json not found. Run: npm install`);
  }
}

function validateExecutables() {
  const sbclOk = spawnSync("sbcl", ["--version"], { encoding: "utf-8", timeout: 5000 });
  if (sbclOk.status !== 0) {
    fail("sbcl not found on PATH. Install SBCL to run the Lisp control plane.");
  }
  const npmOk = spawnSync("npm", ["--version"], { encoding: "utf-8", timeout: 5000 });
  if (npmOk.status !== 0) {
    fail("npm not found on PATH. Install Node.js to run the frontend dev server.");
  }
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
    detached: process.platform !== "win32",
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

// --- Validation phase ---
console.log("Starting Quasar development stack...");
console.log(`  repository: ${repoRoot}`);

validateExecutables();
validateDependencies();

const opensslLib = findOpenSsl();
const env = { ...process.env };
if (opensslLib) {
  env.LD_LIBRARY_PATH = `${opensslLib}:${env.LD_LIBRARY_PATH ?? ""}`;
}

// Isolate ASDF source registry from user-local CL projects (e.g. Lem's qlot)
// that may provide incompatible versions of named-readtables or other deps.
const homeDir = process.env.HOME || "/home/unseen";
env.CL_SOURCE_REGISTRY =
  `(:source-registry (:tree "${homeDir}/quicklisp/local-projects/")` +
  ` (:tree "${homeDir}/quicklisp/dists/quicklisp/software/")` +
  ` (:tree "${repoRoot}systems/") :ignore-inherited-configuration)`;

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
    "--eval", "(quasar.app:main :open-browser-p nil :insecure-development-p t)",
  ],
  { env },
);

// Start the Vite dev server using the tracked frontend package (no npx)
startProcess(
  "vite",
  "npm",
  ["run", "dev", "--", "--port", "5173", "--host"],
  { cwd: frontendDir, env },
);

console.log("\n  control-plane: ws://127.0.0.1:8081  (WebSocket)");
console.log("  control-plane: http://127.0.0.1:8080 (CLOG host)");
console.log("  vite:          http://127.0.0.1:5173  (React UI)\n");
