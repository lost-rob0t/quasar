#!/usr/bin/env node
// Static guard against Common Lisp dependency/bootstrap drift.
//
// The canonical control-plane launcher (scripts/run-control-plane) and
// the test runner (scripts/test-lisp) each maintain a Quicklisp
// pre-load list. This script verifies those lists against the :depends-on
// declarations in the ASDF system definitions under systems/ so the
// developer startup path cannot silently omit a required dependency or
// diverge from the canonical launcher.
//
// Exit code is non-zero on any mismatch.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../", import.meta.url).pathname;
const systemsDir = join(repoRoot, "systems");

function readText(relativePath) {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

// --- Parse :depends-on from an .asd file -----------------------------
function parseAsdDependsOn(asdPath) {
  const text = readText(asdPath);
  const match = text.match(/:depends-on\s*\(([^)]*)\)/s);
  if (!match) {
    throw new Error(`${asdPath}: could not find :depends-on form`);
  }
  const body = match[1];
  const deps = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    deps.push(m[1]);
  }
  return deps;
}

// --- Parse the ql:quickload list from a shell script -----------------
function parseQuickloadList(scriptPath) {
  const text = readText(scriptPath);
  const match = text.match(/ql:quickload\s*\(list\s+([^)]+)\)/);
  if (!match) {
    throw new Error(`${scriptPath}: could not find ql:quickload (list ...) form`);
  }
  return match[1]
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.replace(/^:/, ""));
}

// External (non-quasar) dependencies declared across the given ASD files.
function externalDeps(asdFiles) {
  const all = new Set();
  for (const asd of asdFiles) {
    for (const dep of parseAsdDependsOn(asd)) {
      if (!dep.startsWith("quasar")) {
        all.add(dep);
      }
    }
  }
  return all;
}

function normalize(set) {
  return [...set].sort();
}

function compare(label, expected, actualSet, scriptPath) {
  const expectedSorted = normalize(expected);
  const actualSorted = normalize(actualSet);
  const missing = expectedSorted.filter((d) => !actualSet.has(d));
  const extra = actualSorted.filter((d) => !expected.has(d));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  OK   ${label}: ${actualSorted.join(", ")}`);
    return true;
  }
  console.error(`  FAIL ${label} (${scriptPath})`);
  if (missing.length) {
    console.error(`    missing: ${missing.join(", ")}`);
  }
  if (extra.length) {
    console.error(`    unexpected: ${extra.join(", ")}`);
  }
  return false;
}

console.log("Checking Common Lisp dependency lists against ASDF declarations...");

let ok = true;

// scripts/run-control-plane loads :quasar-web, so its dependency set must
// cover every external dependency declared in quasar-control.asd and
// quasar-web.asd.
const webExpected = externalDeps([
  "systems/quasar-control.asd",
  "systems/quasar-web.asd",
]);
const runControlPlaneActual = new Set(parseQuickloadList("scripts/run-control-plane"));
ok = compare("scripts/run-control-plane", webExpected, runControlPlaneActual, "scripts/run-control-plane") && ok;

// scripts/test-lisp loads :quasar-tests (quasar-control + quasar-starlang
// only — the web layer is not exercised by the Lisp test suite).
const testExpected = externalDeps([
  "systems/quasar-control.asd",
  "systems/quasar-starlang.asd",
]);
const testLispActual = new Set(parseQuickloadList("scripts/test-lisp"));
ok = compare("scripts/test-lisp", testExpected, testLispActual, "scripts/test-lisp") && ok;

// scripts/dev.mjs must delegate to scripts/run-control-plane rather than
// maintaining its own inline SBCL command, so there is nothing to drift.
const devMjs = readText("scripts/dev.mjs");
if (/ql:quickload/.test(devMjs)) {
  console.error("  FAIL scripts/dev.mjs must not inline ql:quickload; delegate to scripts/run-control-plane");
  ok = false;
} else {
  console.log("  OK   scripts/dev.mjs delegates to scripts/run-control-plane");
}

// The CI workflow must not inline its own ql:quickload list either.
const ciYml = readText(".github/workflows/ci.yml");
if (/ql:quickload/.test(ciYml)) {
  console.error("  FAIL .github/workflows/ci.yml must not inline ql:quickload; use scripts/run-control-plane");
  ok = false;
} else {
  console.log("  OK   .github/workflows/ci.yml delegates to scripts/run-control-plane");
}

if (!ok) {
  console.error("\nDependency drift detected. Update the Quicklisp list in the canonical launcher or the ASDF :depends-on declarations.");
  process.exit(1);
}
console.log("\nAll Common Lisp dependency lists are consistent.");
