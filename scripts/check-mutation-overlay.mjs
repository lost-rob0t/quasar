import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (name) => readFileSync(`control-plane/src/${name}.lisp`, 'utf8');
const routing = read('control-plane');
for (const name of ['run-operation', 'handle-transaction']) {
  const start = routing.indexOf(`(defun ${name} `);
  assert(start >= 0, `${name} missing`);
  const end = routing.indexOf('\n(defun ', start + 1);
  const body = routing.slice(start, end < 0 ? undefined : end);
  assert(body.includes('streaming-store-p'), `${name}: durable routing missing`);
  for (const forbidden of ['workspace-for', 'copy-workspace', 'load-workspace']) {
    assert(!body.includes(forbidden), `${name}: ${forbidden}`);
  }
}
for (const name of ['mutation-execution', 'mutation-context-core', 'mutation-context-hydration',
  'mutation-context-integrity', 'mutation-context-operations']) {
  const source = read(name);
  for (const forbidden of ['copy-workspace', 'load-workspace', 'workspace-for', 'tek9::', 'lmdb:']) {
    assert(!source.includes(forbidden), `${name}: ${forbidden}`);
  }
}
assert.equal((read('mutation-execution').match(/:authorize-bytes/g) || []).length, 2,
  'Both durable mutation entrypoints must invoke the quota policy');
console.log('Mutation overlay routing and quota-call structural checks passed (not runtime validation).');
