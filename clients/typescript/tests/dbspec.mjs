// dbspec shared vectors (tests/dbspec/cases.json): canonical documents emit
// unchanged, normalize documents emit their canonical lines, and invalid
// documents report exactly the listed diagnostics in source order.
//
// Usage: node --test clients/typescript/tests/dbspec.mjs (after the build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { emitDbspec, parseDbspec } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const cases = JSON.parse(readFileSync(new URL('tests/dbspec/cases.json', root), 'utf8'));
const TIMEOUT = 15000;

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
export function vector(name, body) {
  test(name, { timeout: TIMEOUT }, async () => {
    const started = performance.now();
    console.log(`start ${name}`);
    try {
      await body();
    } catch (error) {
      console.log(`fail ${name} ${(performance.now() - started).toFixed(1)} ms`);
      throw error;
    }
    console.log(`pass ${name} ${(performance.now() - started).toFixed(1)} ms`);
  });
}

function join(lines, crlf) {
  const end = crlf ? '\r\n' : '\n';
  return lines.join(end) + end;
}

function documentSet(c) {
  const set = {};
  for (const [name, lines] of Object.entries(c.documents)) if (name !== c.main) set[name] = join(lines, c.crlf === true);
  return set;
}

function parsed(text, set) {
  const result = parseDbspec(text, set);
  assert.deepEqual(result.diagnostics, [], 'diagnostics of a valid document');
  assert.notEqual(result.document, null);
  return result.document;
}

assert(cases.canonical.length > 0 && cases.normalize.length > 0 && cases.invalid.length > 0);
const ids = [...cases.canonical, ...cases.normalize, ...cases.invalid].map(c => c.id);
assert.equal(new Set(ids).size, ids.length, 'unique case ids');

for (const c of cases.canonical) {
  vector(`canonical ${c.id}`, () => {
    const text = join(c.documents[c.main], c.crlf === true);
    const set = documentSet(c);
    const emitted = emitDbspec(parsed(text, set));
    assert.equal(emitted, text);
    assert.equal(emitDbspec(parsed(emitted, set)), emitted);
  });
}

for (const c of cases.normalize) {
  vector(`normalize ${c.id}`, () => {
    const text = join(c.documents[c.main], c.crlf === true);
    const set = documentSet(c);
    const canonical = join(c.canonical, false);
    const emitted = emitDbspec(parsed(text, set));
    assert.equal(emitted, canonical);
    assert.equal(emitDbspec(parsed(emitted, set)), emitted);
  });
}

for (const c of cases.invalid) {
  vector(`invalid ${c.id}`, () => {
    const text = join(c.documents[c.main], c.crlf === true);
    const result = parseDbspec(text, documentSet(c));
    assert.equal(result.document, null);
    assert.deepEqual(result.diagnostics.map(d => ({ line: d.line, column: d.column, rule: d.rule })), c.errors);
    for (const d of result.diagnostics) {
      assert.deepEqual(Object.keys(d).sort(), ['column', 'line', 'message', 'rule']);
      assert.equal(typeof d.message, 'string');
      assert(d.message.length > 0);
    }
  });
}
