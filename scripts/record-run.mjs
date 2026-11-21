#!/usr/bin/env node
// Record test-run facts into the durable run ledger (.prolog/runs/run-<HEAD>.pl).
//
// One fact set per (commit, suite, seq). The expert pack (dotfiles
// .zara/experts/quasar-ui, kb/run_ledger.pl) consumes these files through
// an explicit-path adapter: per-suite latest result, commit health,
// first failing commit across an ordered history. The ledger is the
// self-updating half of the KB.
//
// Usage:
//   node scripts/record-run.mjs vitest
//   node scripts/record-run.mjs e2e e2e/graph-cascade-menu.spec.ts
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SUITE = process.argv[2];
const EXTRA = process.argv.slice(3);

const RUNNERS = {
  vitest: {
    cwd: "frontend",
    cmd: ["npx", "vitest", "run", "--reporter=json", `--outputFile=${join(tmpdir(), "quasar-vitest.json")}`],
    parse: () => parseVitest(readFileSync(join(tmpdir(), "quasar-vitest.json"), "utf8"))
  },
  e2e: {
    cwd: "frontend",
    cmd: ["npx", "playwright", "test", ...EXTRA, "--reporter=json"],
    parse: (stdout) => parsePlaywright(stdout)
  }
};

function parseVitest(json) {
  const d = JSON.parse(json);
  const failures = [];
  for (const file of d.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      if (a.status === "failed") failures.push(a.fullName || a.title);
    }
  }
  return { total: d.numTotalTests ?? 0, passed: d.numPassedTests ?? 0, failed: d.numFailedTests ?? 0, failures };
}

function parsePlaywright(json) {
  const d = JSON.parse(json.slice(json.indexOf("{")));
  const failures = [];
  let total = 0, passed = 0, failed = 0;
  const walk = (suite) => {
    for (const s of suite.suites ?? []) walk(s);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const statuses = (t.results ?? []).map((r) => r.status);
        const bad = statuses.some((s) => s === "failed" || s === "timedOut");
        const ok = statuses.includes("passed");
        if (bad) {
          failed += 1;
          failures.push(spec.title);
        } else if (ok) {
          passed += 1;
        }
        // Never-run/skipped-only specs count as neither pass nor fail
        // (skip gates for live-data journeys keep CI honest without
        // inflating green).
        total += bad || ok ? 1 : 0;
      }
    }
  };
  walk(d.suites?.[0] ?? {});
  return { total, passed, failed, failures };
}

function plQuote(text) {
  return `'${String(text).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function sh(cmd, cwd) {
  return execFileSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

const runner = RUNNERS[SUITE];
if (!runner) {
  console.error(`unknown suite '${SUITE}' (known: ${Object.keys(RUNNERS).join(", ")})`);
  process.exit(2);
}

const commit = sh(["git", "rev-parse", "--short=8", "HEAD"], ROOT).trim();
const suiteTerm = SUITE === "e2e" ? `suite_e2e(${plQuote(EXTRA.join(" ") || "all")})` : `suite_${SUITE}`;
const started = new Date().toISOString();

let parsed;
let exitCode = 0;
try {
  parsed = runner.parse(sh(runner.cmd, join(ROOT, runner.cwd)));
} catch (err) {
  // Non-zero suite exit still produces parseable output on stdout/stderr.
  const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  try {
    parsed = runner.parse(out);
  } catch {
    console.error(out.slice(-4000));
    process.exit(1);
  }
  exitCode = err.status ?? 1;
}

// Per-(commit, suite) sequence number: max recorded + 1, so reruns append
// instead of clobbering; the ledger reader treats the max seq as latest.
const ledgerPath = join(ROOT, ".prolog", "runs", `run-${commit}.pl`);
const prefix = suiteTerm.split("(")[0];
let seq = 1;
if (existsSync(ledgerPath)) {
  const recorded = [...readFileSync(ledgerPath, "utf8").matchAll(
    new RegExp(String.raw`test_run\('${commit}',\s*(\d+),\s*${prefix}`, "g")
  )];
  if (recorded.length) seq = Math.max(...recorded.map((m) => Number(m[1]))) + 1;
}

mkdirSync(join(ROOT, ".prolog", "runs"), { recursive: true });
const result = parsed.failed === 0 ? "pass" : "fail";
const lines = [
  `test_run('${commit}', ${seq}, ${suiteTerm}, ${result}, ${parsed.passed}, ${parsed.failed}, '${started}').`,
  ...parsed.failures.map((f) => `test_failure('${commit}', ${seq}, ${suiteTerm}, ${plQuote(f)}).`),
  ""
];
appendFileSync(ledgerPath, lines.join("\n"));

console.log(`ledger: run-${commit}.pl seq=${seq} ${suiteTerm} -> ${result} (${parsed.passed}/${parsed.total} passed, ${parsed.failed} failed)`);
process.exit(exitCode);
