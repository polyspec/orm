// dbspec stress: the 2000-table, 60000-column, 10000-foreign-key canonical
// document that node tests/dbspec/stress.mjs writes is parsed and emitted;
// the emission equals the document and a second emission equals the first.
// The document is parsed five times; the shortest, median and longest main
// thread CPU time of a parse are printed, and the median fails above the
// TypeScript budget (docs/dbspec.md, "Verification").
//
// 시간 제한은 parse를 실행한 main thread의 CPU 시간(process.threadCpuUsage)으로 잰다. 공유
// machine에서 wall-clock 시간은 다른 process가 CPU를 쓰는 동안 기다린 시간도 담고, process
// CPU 시간은 다른 thread에서 도는 garbage collector의 시간도 담는다. wall-clock 시간은 함께
// 출력만 한다.
//
// Usage: node --test clients/typescript/tests/dbspec-stress.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { emitDbspec, parseDbspec } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const generator = fileURLToPath(new URL('tests/dbspec/stress.mjs', root));
const TIMEOUT = 60000;
const PARSE_BUDGET_MS = 250;
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
    assert.ok(parseMs <= PARSE_BUDGET_MS, `median parse CPU ${parseMs.toFixed(1)} ms exceeds the ${PARSE_BUDGET_MS} ms budget`);
});
