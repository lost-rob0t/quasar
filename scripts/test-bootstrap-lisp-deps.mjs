import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bootstrap = readFileSync(join(sourceRoot, "scripts/bootstrap-lisp-deps"), "utf8");
const tek9Sha = bootstrap.match(/TEK9_SHA="([0-9a-f]{40})"/)[1];
const clogSha = bootstrap.match(/CLOG_SHA="([0-9a-f]{40})"/)[1];
const narHash = `sha256-${Buffer.alloc(32, 7).toString("base64")}`;

// Git and Nix are external effects here. The unchanged fresh-Nix CI job is the
// real hash/bootstrap/startup proof; these tests exercise fail-closed routing.
function fixture(t, kind = "source") {
  const root = mkdtempSync(join(tmpdir(), "quasar-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const tek9 = join(root, "tek9 source");
  mkdirSync(bin);
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/bootstrap-lisp-deps"), bootstrap);
  const verifier = join(sourceRoot, "scripts/check-tek9-nix-source.mjs");
  if (existsSync(verifier)) {
    writeFileSync(join(root, "scripts/check-tek9-nix-source.mjs"), readFileSync(verifier));
  }
  const lock = {
    root: "root",
    nodes: {
      root: { inputs: { tek9: "tek9" } },
      tek9: { locked: { rev: tek9Sha, narHash } },
    },
  };
  const saveLock = () => writeFileSync(join(root, "flake.lock"), JSON.stringify(lock));
  saveLock();
  if (kind !== "absent") {
    mkdirSync(tek9);
    writeFileSync(join(tek9, "source.lisp"), "source must stay unchanged\n");
    if (kind === "git") mkdirSync(join(tek9, ".git"));
  }
  const gitLog = join(root, "git.log");
  const nixLog = join(root, "nix.log");
  writeFileSync(join(bin, "git"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GIT_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'clone') {
  const target = a.at(-1);
  if (fs.existsSync(target) && fs.readdirSync(target).length) process.exit(128);
  fs.mkdirSync(path.join(target, '.git'), {recursive: true});
} else if (a[0] === '-C') {
  if (a[2] === 'diff' && process.env.DIRTY_TEK9 === '1' && a[1] === process.env.QUASAR_TEK9_PATH) process.exit(1);
  if (a[2] === 'rev-parse') console.log(a[1] === process.env.QUASAR_TEK9_PATH ? process.env.TEK9_SHA : process.env.CLOG_SHA);
} else process.exit(99);
`, { mode: 0o755 });
  writeFileSync(join(bin, "nix"), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.NIX_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.NIX_FAIL === '1') process.exit(42);
console.log(process.env.NAR_HASH);
`, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    QUASAR_TEK9_PATH: tek9,
    QUASAR_QUICKLISP_LOCAL_PROJECTS: join(root, "local-projects"),
    GIT_LOG: gitLog, NIX_LOG: nixLog, TEK9_SHA: tek9Sha, CLOG_SHA: clogSha,
    NAR_HASH: narHash, NIX_FAIL: "0", DIRTY_TEK9: "0",
  };
  const log = (path) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(JSON.parse) : [];
  return {
    root, tek9, lock, env, saveLock,
    run: () => spawnSync("bash", ["scripts/bootstrap-lisp-deps"], { cwd: root, env, encoding: "utf8" }),
    git: () => log(gitLog), nix: () => log(nixLog),
  };
}

test("locked source is verified without cloning into or altering it", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified Tek9 source/);
  assert.deepEqual(f.nix(), [["hash", "path", "--type", "sha256", "--sri", f.tek9]]);
  assert.equal(f.git().some(args => args.includes(f.tek9)), false);
  assert.equal(existsSync(join(f.tek9, ".git")), false);
  assert.equal(readFileSync(join(f.tek9, "source.lisp"), "utf8"), "source must stay unchanged\n");
});

for (const [name, change, message] of [
  ["wrong revision", f => { f.lock.nodes.tek9.locked.rev = "a".repeat(40); f.saveLock(); }, /revision/],
  ["wrong content hash", f => { f.env.NAR_HASH = `sha256-${Buffer.alloc(32, 8).toString("base64")}`; }, /hash mismatch/],
  ["missing hash", f => { delete f.lock.nodes.tek9.locked.narHash; f.saveLock(); }, /SHA-256 NAR hash/],
  ["malformed hash", f => { f.lock.nodes.tek9.locked.narHash = "sha256-short"; f.saveLock(); }, /SHA-256 NAR hash/],
  ["missing Tek9 input", f => { delete f.lock.nodes.root.inputs.tek9; f.saveLock(); }, /Tek9 input/],
  ["malformed lock", f => { writeFileSync(join(f.root, "flake.lock"), "{"); }, /Cannot verify/],
  ["failed hash command", f => { f.env.NIX_FAIL = "1"; }, /Nix hash failed/],
  ["empty hash output", f => { f.env.NAR_HASH = ""; }, /hash mismatch/],
]) {
  test(`rejects ${name} before dependency mutation`, (t) => {
    const f = fixture(t);
    change(f);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.deepEqual(f.git(), []);
    assert.equal(readFileSync(join(f.tek9, "source.lisp"), "utf8"), "source must stay unchanged\n");
  });
}

test("a fresh Git dependency is still cloned and checked out at the exact pin", (t) => {
  const f = fixture(t, "absent");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.git().some(args => args[0] === "clone" && args.at(-1) === f.tek9));
  assert.ok(f.git().some(args => args[1] === f.tek9 && args.includes("--detach") && args.includes(tek9Sha)));
  assert.deepEqual(f.nix(), []);
});

test("an unavailable Nix command cannot approve a source tree", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath,
    ["scripts/check-tek9-nix-source.mjs", f.tek9, tek9Sha],
    { cwd: f.root, env: { ...f.env, PATH: join(f.root, "missing-tools") }, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Nix hash failed/);
  assert.deepEqual(f.git(), []);
});

test("an existing clean Git dependency retains the Git pin verification path", (t) => {
  const f = fixture(t, "git");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.git().some(args => args[1] === f.tek9 && args[2] === "rev-parse"));
  assert.deepEqual(f.nix(), []);
});

test("an existing dirty Git dependency is still refused", (t) => {
  const f = fixture(t, "git");
  f.env.DIRTY_TEK9 = "1";
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite dirty dependency checkout/);
  assert.equal(f.git().some(args => args[1] === f.tek9 && args[2] === "checkout"), false);
  assert.deepEqual(f.nix(), []);
});
