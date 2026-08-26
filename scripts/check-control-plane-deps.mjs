#!/usr/bin/env node
// Static guard against Common Lisp dependency/bootstrap and storage-boundary drift.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = new URL("../", import.meta.url).pathname;
const expectedTek9Sha = "ca24ef35ea6877420cbca057dd7fb702fe29a740";

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
  let matchItem;
  while ((matchItem = re.exec(match[1])) !== null) {
    deps.push(matchItem[1]);
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
  const missing = expectedSorted.filter((dep) => !actualSet.has(dep));
  const extra = actualSorted.filter((dep) => !expected.has(dep));
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

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function checkForbidden(label, relativeFiles, patterns) {
  let clean = true;
  for (const file of relativeFiles) {
    const text = readText(file);
    for (const [description, pattern] of patterns) {
      if (pattern.test(text)) {
        console.error(`  FAIL ${label}: ${file} contains ${description}`);
        clean = false;
      }
    }
  }
  if (clean) {
    console.log(`  OK   ${label}`);
  }
  return clean;
}

console.log("Checking Common Lisp dependency lists against ASDF declarations...");

let ok = true;

const webExpected = externalDeps(["systems/quasar-control.asd", "systems/quasar-web.asd"]);
const runControlPlaneActual = new Set(parseQuickloadList("scripts/run-control-plane"));
ok =
  compare(
    "scripts/run-control-plane",
    webExpected,
    runControlPlaneActual,
    "scripts/run-control-plane"
  ) && ok;

const testExpected = externalDeps([
  "systems/quasar-control.asd",
  "systems/quasar-starlang.asd",
  "systems/quasar-web.asd"
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
  if (tek9Pin[1] !== expectedTek9Sha) {
    console.error(
      `  FAIL Tek9 pin drifted from verified master ${expectedTek9Sha} to ${tek9Pin[1]}`
    );
    ok = false;
  } else {
    console.log(`  OK   Tek9 pin matches verified master ${expectedTek9Sha}`);
  }
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

console.log("\nChecking Quasar/Tek9 storage boundaries...");

const controlPlaneRoot = join(repoRoot, "control-plane/src");
const controlPlaneLisp = walkFiles(controlPlaneRoot)
  .filter((file) => file.endsWith(".lisp"))
  .map((file) => relative(repoRoot, file));
ok =
  checkForbidden("Quasar uses exported Tek9 APIs only", controlPlaneLisp, [
    ["a private tek9:: call", /tek9::/i],
    ["a raw lmdb:* call", /\blmdb:/i]
  ]) && ok;

const phase2Files = controlPlaneLisp.filter((file) => /\/phase2-[^/]+\.lisp$/.test(file));
ok =
  checkForbidden("Phase 2 contains no corpus-sized heap import/read sinks", phase2Files, [
    ["copy-workspace", /\bcopy-workspace\b/i],
    ["encoded-chunks", /\bencoded-chunks\b/i],
    ["hash-table-values", /\bhash-table-values\b/i]
  ]) && ok;

const readBoundary = ["control-plane/src/phase2-read-hardening.lisp"];
ok =
  checkForbidden("Phase 2 read handlers stay on bounded Tek9 pages", readBoundary, [
    ["load-workspace", /\bload-workspace\b/i],
    ["workspace-for", /\bworkspace-for\b/i],
    ["unbounded direct-document-list", /\bdirect-document-list\b/i],
    ["unbounded range materialization", /\b%range-values\b/i]
  ]) && ok;

if (!ok) {
  console.error(
    "\nDependency or storage-boundary drift detected. Fix the architecture instead of weakening this guard."
  );
  process.exit(1);
}
console.log("\nAll Common Lisp dependency, bootstrap, and Phase 2 storage boundaries are consistent.");
