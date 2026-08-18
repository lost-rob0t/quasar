import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function fail(message) {
  console.error(`[record-bounded-mutations] ${message}`);
  process.exitCode = 1;
}

function defunBody(source, name) {
  const start = source.indexOf(`(defun ${name} `);
  if (start < 0) {
    fail(`missing authoritative ${name} definition`);
    return "";
  }
  const next = source.indexOf("\n(defun ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function lispFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return lispFiles(absolute);
    if (entry.isFile() && entry.name.endsWith(".lisp")) return [absolute];
    return [];
  });
}

const routingPath = "control-plane/src/control-plane-mutations.lisp";
const routing = read(routingPath);
const runOperation = defunBody(routing, "run-operation");
const handleTransaction = defunBody(routing, "handle-transaction");

for (const [name, body] of [
  ["run-operation", runOperation],
  ["handle-transaction", handleTransaction],
]) {
  for (const forbidden of ["workspace-for", "copy-workspace", "load-workspace"]) {
    if (body.includes(forbidden)) {
      fail(`${name} regressed to ${forbidden}`);
    }
  }
  if (!body.includes("streaming-store-p")) {
    fail(`${name} no longer makes the durable-store routing boundary explicit`);
  }
}

const boundedFiles = [
  "control-plane/src/mutation-store.lisp",
  "control-plane/src/mutation-store-alternates.lisp",
  "control-plane/src/mutation-context-core.lisp",
  "control-plane/src/mutation-context-hydration.lisp",
  "control-plane/src/mutation-context-integrity.lisp",
  "control-plane/src/mutation-context-operations.lisp",
  "control-plane/src/mutation-execution.lisp",
];

for (const relativePath of boundedFiles) {
  const source = read(relativePath);
  for (const forbidden of ["copy-workspace", "load-workspace", "tek9::", "lmdb:"]) {
    if (source.includes(forbidden)) {
      fail(`${relativePath} contains forbidden bounded-path dependency ${forbidden}`);
    }
  }
}

for (const absolutePath of lispFiles(path.join(root, "control-plane/src"))) {
  const source = fs.readFileSync(absolutePath, "utf8");
  const relativePath = path.relative(root, absolutePath);
  if (source.includes("tek9::")) {
    fail(`${relativePath} bypasses the public Tek9 package boundary`);
  }
  if (source.includes("lmdb:")) {
    fail(`${relativePath} leaks raw LMDB APIs into Quasar`);
  }
}

if (!process.exitCode) {
  console.log("Record-bounded mutation architecture checks passed.");
}
