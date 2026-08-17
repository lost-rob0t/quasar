#!/usr/bin/env node
// Static guard against Common Lisp dependency/bootstrap drift.
//
// The canonical control-plane launcher (scripts/run-control-plane) and
// test runner (scripts/test-lisp) each maintain a Quicklisp pre-load list.
// This script verifies those lists against ASDF :depends-on declarations.
// Git-pinned source dependencies are owned by scripts/bootstrap-lisp-deps;
// CI must delegate to that script instead of duplicating clone/pin commands.
//
// Exit code is non-zero on any mismatch.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../", import.meta.url).pathname;

function readText(relativePath) {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

function parseAsdDependsOn(asdPath) {
  const text = readText(asdPath);
  const match = text.match(/:depends-on\s*\(([^)]*)\)/s);
  if (!match) {
    throw new Error(`${asdPath}: could not find :depends-on form`);
  }
  const deps = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(match[1])) !== null) {
    deps.push(m[1]);
  }
  return deps;
}

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

const webExpected = externalDeps([
  "systems/quasar-control.asd",
  "systems/quasar-web.asd",
]);
const runControlPlaneActual = new Set(parseQuickloadList("scripts/run-control-plane"));
ok = compare("scripts/run-control-plane", webExpected, runControlPlaneActual, "scripts/run-control-plane") && ok;

const testExpected = externalDeps([
  "systems/quasar-control.asd",
  "systems/quasar-starlang.asd",
]);
const testLispActual = new Set(parseQuickloadList("scripts/test-lisp"));
ok = compare("scripts/test-lisp", testExpected, testLispActual, "scripts/test-lisp") && ok;

const devMjs = readText("scripts/dev.mjs");
if (/ql:quickload/.test(devMjs)) {
  console.error("  FAIL scripts/dev.mjs must not inline ql:quickload; delegate to scripts/run-control-plane");
  ok = false;
} else {
  console.log("  OK   scripts/dev.mjs delegates to scripts/run-control-plane");
}

const bootstrap = readText("scripts/bootstrap-lisp-deps");
const clogPin = bootstrap.match(/CLOG_SHA="([0-9a-f]{40})"/);
const tek9Pin = bootstrap.match(/TEK9_SHA="([0-9a-f]{40})"/);
if (!clogPin || !tek9Pin) {
  console.error("  FAIL scripts/bootstrap-lisp-deps must pin CLOG_SHA and TEK9_SHA to full commit SHAs");
  ok = false;
} else {
  console.log(`  OK   scripts/bootstrap-lisp-deps pins CLOG ${clogPin[1]} and Tek9 ${tek9Pin[1]}`);
}

const ciYml = readText(".github/workflows/ci.yml");
if (/ql:quickload/.test(ciYml)) {
  console.error("  FAIL .github/workflows/ci.yml must not inline ql:quickload; use scripts/run-control-plane");
  ok = false;
} else {
  console.log("  OK   .github/workflows/ci.yml does not inline ql:quickload");
}
if (!ciYml.includes("bash scripts/bootstrap-lisp-deps")) {
  console.error("  FAIL .github/workflows/ci.yml must delegate git-pinned Lisp sources to scripts/bootstrap-lisp-deps");
  ok = false;
} else if (/git clone[^\n]*(?:clog|tek9)/i.test(ciYml)) {
  console.error("  FAIL .github/workflows/ci.yml duplicates a pinned Lisp dependency clone; keep it in scripts/bootstrap-lisp-deps");
  ok = false;
} else {
  console.log("  OK   .github/workflows/ci.yml delegates pinned Lisp sources to scripts/bootstrap-lisp-deps");
}

if (!ok) {
  console.error("\nDependency drift detected. Update ASDF, canonical Quicklisp lists, or scripts/bootstrap-lisp-deps as appropriate.");
  process.exit(1);
}
console.log("\nAll Common Lisp dependency and bootstrap declarations are consistent.");
