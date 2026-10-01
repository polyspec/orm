// dbspec stress: the 2000-table, 60000-column, 10000-foreign-key canonical
// document that node tests/dbspec/stress.mjs writes is parsed and emitted;
// the emission equals the document and a second emission equals the first.
// Parse and emit times are printed, and the parse fails above the TypeScript
// budget (docs/dbspec.md, "Verification").
//
// Usage: node --test clients/typescript/tests/dbspec-stress.mjs (after the build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { emitDbspec, parseDbspec } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const generator = fileURLToPath(new URL('tests/dbspec/stress.mjs', root));
const TIMEOUT = 60000;
const PARSE_BUDGET_MS = 250;

function generate() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [generator], { maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT }, (error, stdout, stderr) => {
      if (error) reject(new Error(`stress generator failed: ${error.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

test('dbspec stress document parses and emits canonically', { timeout: TIMEOUT }, async () => {
  const started = performance.now();
  console.log('start dbspec stress');
  try {
    const text = await generate();
    console.log(`step generated ${Buffer.byteLength(text)} bytes in ${(performance.now() - started).toFixed(1)} ms`);
    const parseStart = performance.now();
    const result = parseDbspec(text, {});
    const parseMs = performance.now() - parseStart;
    assert.deepEqual(result.diagnostics, []);
    const document = result.document;
    assert.equal(document.tables.length, 2000);
    assert.equal(document.tables.reduce((n, t) => n + t.columns.length, 0), 60000);
    assert.equal(document.tables.reduce((n, t) => n + t.foreignKeys.length, 0), 10000);
    const emitStart = performance.now();
    const first = emitDbspec(document);
    const emitMs = performance.now() - emitStart;
    const second = emitDbspec(document);
    console.log(`step parse ${parseMs.toFixed(1)} ms emit ${emitMs.toFixed(1)} ms`);
    assert.equal(first, text);
    assert.equal(second, first);
    assert.ok(parseMs <= PARSE_BUDGET_MS, `parse ${parseMs.toFixed(1)} ms exceeds the ${PARSE_BUDGET_MS} ms budget`);
  } catch (error) {
    console.log(`fail dbspec stress ${(performance.now() - started).toFixed(1)} ms`);
    throw error;
  }
  console.log(`pass dbspec stress ${(performance.now() - started).toFixed(1)} ms`);
});
