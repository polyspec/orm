// dbspec stress: the 2000-table, 60000-column, 10000-foreign-key canonical
// document that node tests/dbspec/stress.mts writes is parsed and emitted;
// the emission equals the document and a second emission equals the first.
// The document is parsed five times; the shortest, median and longest main
// thread CPU time of a parse are printed with the ratio of the median to the
// reference work, and a ratio above REFERENCE_RATIO prints a warning
// (docs/spec/dbspec.md, "Verification"); a measurement never fails the test.
//
// The time limit is measured as the CPU time of the main thread that ran parse (process.threadCpuUsage). On a shared
// machine, wall-clock time also includes the time spent waiting while other processes use the CPU, and process
// CPU time also includes the time of the garbage collector running on other threads. Wall-clock time is
// only printed.
//
// Usage: node --test packages/ts/tests/dbspec-stress.mjs (after the build)
import { caseTest, warning } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { emitDbspec, parseDbspec } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const generator = fileURLToPath(new URL('tests/dbspec/stress.mts', root));
const TIMEOUT = 60000;
// REFERENCE_RATIO is the documented reference value of the ratio of the median parse CPU time to the median CPU time of
// the reference work (docs/spec/dbspec.md, "Verification"). A ratio above it prints a warning; a measurement never fails the
// test.
const REFERENCE_RATIO = 185;
const PARSES = 5;

function generate() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [generator], { maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT }, (error, stdout, stderr) => {
      if (error) reject(new Error(`stress generator failed: ${error.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

caseTest('dbspec stress document parses and emits canonically', TIMEOUT, async ({ step }) => {
    const text = await generate();
    step(`generated ${Buffer.byteLength(text)} bytes`);
    const parses = [];
    let result;
    for (let i = 0; i < PARSES; i++) {
      const wallStart = performance.now();
      const cpuStart = process.threadCpuUsage();
      result = parseDbspec(text, {});
      const cpu = process.threadCpuUsage(cpuStart);
      const cpuMs = (cpu.user + cpu.system) / 1000;
      step(`parse cpu ${cpuMs.toFixed(1)} ms wall ${(performance.now() - wallStart).toFixed(1)} ms`);
      parses.push(cpuMs);
    }
    parses.sort((a, b) => a - b);
    const parseMs = parses[Math.floor(PARSES / 2)];
    // The baseline work is a loop that updates a checksum for each byte of the same document. It is measured on the same thread with the same clock, and the ratio to the parse time
    // is printed (docs/spec/dbspec.md, Verification).
    const bytes = Buffer.from(text);
    const references = [];
    let sum = 0;
    for (let i = 0; i < PARSES; i++) {
      const cpuStart = process.threadCpuUsage();
      sum = referenceScan(bytes);
      const cpu = process.threadCpuUsage(cpuStart);
      references.push((cpu.user + cpu.system) / 1000);
    }
    references.sort((a, b) => a - b);
    const referenceMs = references[Math.floor(PARSES / 2)];
    step(`reference cpu median ${referenceMs.toFixed(3)} ms ratio ${(parseMs / referenceMs).toFixed(2)} sum ${sum}`);
    assert.deepEqual(result.diagnostics, []);
    const document = result.document;
    assert.equal(document.tables.length, 2000);
    assert.equal(document.tables.reduce((n, t) => n + t.columns.length, 0), 60000);
    assert.equal(document.tables.reduce((n, t) => n + t.foreignKeys.length, 0), 10000);
    const emitStart = performance.now();
    const first = emitDbspec(document);
    const emitMs = performance.now() - emitStart;
    const second = emitDbspec(document);
    step(`parse cpu min ${parses[0].toFixed(1)} median ${parseMs.toFixed(1)} max ${parses[PARSES - 1].toFixed(1)} ms emit ${emitMs.toFixed(1)} ms`);
    assert.equal(first, text);
    assert.equal(second, first);
    const ratio = parseMs / referenceMs;
    const machine = `${process.platform} ${process.arch}, Node ${process.version}`;
    step(`parse ratio ${ratio.toFixed(2)} to the reference on ${machine} (reference ratio ${REFERENCE_RATIO})`);
    if (ratio > REFERENCE_RATIO)
      warning(`median parse CPU of ${parseMs.toFixed(3)} ms is ${ratio.toFixed(2)} times the reference CPU of ${referenceMs.toFixed(3)} ms, above the reference ratio ${REFERENCE_RATIO} (docs/spec/dbspec.md, Verification); machine ${machine}`);
});

// referenceScan is the baseline work for the stress document: for each byte in turn, it computes h = h*31 + b (mod 2^32).
function referenceScan(bytes) {
  let h = 0;
  for (let i = 0; i < bytes.length; i++) h = (Math.imul(h, 31) + bytes[i]) >>> 0;
  return h;
}
