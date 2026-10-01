// dbspec Mermaid diagrams (tests/dbspec/mermaid.json, docs/mermaid.md):
// every export case writes exactly its Mermaid lines and dropped objects;
// every import case reads its Mermaid lines into exactly its document and
// dropped objects; every invalid case reports exactly its diagnostics.
//
// Usage: node --test clients/typescript/tests/dbspec-mermaid.mjs (after the build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { emitDbspec, exportMermaid, importMermaid, parseDbspec } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const vectors = JSON.parse(readFileSync(new URL('tests/dbspec/mermaid.json', root), 'utf8'));
const TIMEOUT = 5000;

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
function vector(name, body) {
  test(name, { timeout: TIMEOUT }, async () => {
    const started = performance.now();
    console.log(`start ${name}`);
    try {
      await body();
    } catch (error) {
      console.log(`result ${name}: FAIL after ${(performance.now() - started).toFixed(1)} ms`);
      throw error;
    }
    console.log(`result ${name}: PASS after ${(performance.now() - started).toFixed(1)} ms`);
  });
}

const text = lines => lines.join('\n') + '\n';
const drops = dropped => dropped.map(u => [u.kind, u.table, u.name]);

assert.equal(vectors.version, 1, 'mermaid vectors version');
assert(vectors.export.length > 0 && vectors.import.length > 0 && vectors.invalid.length > 0, 'mermaid vectors have export, import and invalid cases');
let runs = 0;

for (const c of vectors.export) {
  vector(`mermaid export ${c.id}`, () => {
    const parsed = parseDbspec(text(c.document), {});
    assert.deepEqual(parsed.diagnostics, [], 'document diagnostics');
    const { mermaid, dropped } = exportMermaid(parsed.document);
    assert.equal(mermaid, text(c.mermaid), 'mermaid text');
    assert.deepEqual(drops(dropped), c.dropped, 'dropped');
    runs++;
  });
}

for (const c of vectors.import) {
  vector(`mermaid import ${c.id}`, () => {
    const result = importMermaid(text(c.mermaid), 'imported');
    assert.deepEqual(result.diagnostics, [], 'diagnostics');
    assert.equal(emitDbspec(result.document), text(c.document), 'document');
    assert.deepEqual(drops(result.dropped), c.dropped, 'dropped');
    runs++;
  });
}

for (const c of vectors.invalid) {
  vector(`mermaid invalid ${c.id}`, () => {
    const result = importMermaid(text(c.mermaid), 'imported');
    assert.equal(result.document, null, 'document of an invalid diagram');
    assert.deepEqual(result.diagnostics.map(d => [d.rule, d.line, d.column]), c.errors, 'diagnostics');
    runs++;
  });
}

vector('every mermaid case runs', () => {
  const cases = vectors.export.length + vectors.import.length + vectors.invalid.length;
  assert.equal(runs, cases);
  console.log(`mermaid cases: ${runs} (${vectors.export.length} export, ${vectors.import.length} import, ${vectors.invalid.length} invalid)`);
});
