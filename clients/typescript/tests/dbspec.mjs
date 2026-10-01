// dbspec shared vectors (tests/dbspec/cases.json): canonical documents emit
// unchanged, normalize documents emit their canonical lines, and invalid
// documents report exactly the listed diagnostics in source order.
//
// Usage: node --test clients/typescript/tests/dbspec.mjs (after the build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dbspecManifest, emitDbspec, parseDbspec } from '../dist/dbspec/index.js';

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

// join writes the lines with LF, with CRLF when crlf is true, or with
// alternating CRLF and LF and no final line end when mixed is true.
function join(lines, crlf, mixed = false) {
  if (mixed) return lines.map((line, i) => (i === lines.length - 1 ? line : line + (i % 2 === 0 ? '\r\n' : '\n'))).join('');
  const end = crlf ? '\r\n' : '\n';
  return lines.join(end) + end;
}

function documentSet(c) {
  const set = {};
  for (const [name, lines] of Object.entries(c.documents)) if (name !== c.main) set[name] = join(lines, c.crlf === true, c.mixed === true);
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
    const text = join(c.documents[c.main], c.crlf === true, c.mixed === true);
    const set = documentSet(c);
    const emitted = emitDbspec(parsed(text, set));
    assert.equal(emitted, text);
    assert.equal(emitDbspec(parsed(emitted, set)), emitted);
  });
}

for (const c of cases.normalize) {
  vector(`normalize ${c.id}`, () => {
    const text = join(c.documents[c.main], c.crlf === true, c.mixed === true);
    const set = documentSet(c);
    const canonical = join(c.canonical, false);
    const emitted = emitDbspec(parsed(text, set));
    assert.equal(emitted, canonical);
    assert.equal(emitDbspec(parsed(emitted, set)), emitted);
  });
}

for (const c of cases.invalid) {
  vector(`invalid ${c.id}`, () => {
    const text = join(c.documents[c.main], c.crlf === true, c.mixed === true);
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

// parseSet parses every document of a hashes case against the others, in document name order.
function parseSet(c) {
  return Object.keys(c.documents).sort().map(name => {
    const set = {};
    for (const [other, lines] of Object.entries(c.documents)) if (other !== name) set[other] = join(lines, false);
    return parsed(join(c.documents[name], false), set);
  });
}

function expectManifest(c, documents) {
  const result = dbspecManifest(documents);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.manifest.manifestText, join(c.manifestText, false));
  assert.equal(result.manifest.schemaText, join(c.schemaText, false));
  assert.equal(result.manifest.manifestHash, c.manifestHash);
  assert.equal(result.manifest.schemaHash, c.schemaHash);
}

assert(cases.hashes.length > 0, 'hashes cases');
for (const c of cases.hashes) {
  vector(`hashes ${c.id}`, () => {
    const documents = parseSet(c);
    expectManifest(c, documents);
    // The set is ordered by document name, not by the order given.
    expectManifest(c, [...documents].reverse());
  });
}

vector('manifest rejects a repeated document name', () => {
  const text = join(['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  primary key (id)', '}'], false);
  const result = dbspecManifest([parsed(text, {}), parsed(text, {})]);
  assert.equal(result.manifest, null);
  assert.deepEqual(result.diagnostics.map(d => [d.rule, d.line, d.column]), [['name.duplicate', 1, 10]]);
});
