// feature coverage case 실행부(packages/ts/tests/coverage_case.mjs)의 unit test다. 실행부는
// TypeScript coverage test가 함께 쓰므로, 그 변경은 모든 기능의 coverage가 아니라 이 test가
// 검사한다(contracts/features.json의 helpers). 전체 coverage는 make check가 실행한다.
// Usage: node packages/ts/tests/coverage-case-unit.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorCode, runCases, withCleanup } from './coverage_case.mjs';
import { coverageItems } from '../../../scripts/features/coverage.mts';
import { cases, COMPUTE } from '../../../tests/testcase.mts';

// runCases는 명령 줄의 case ID를 읽으므로 각 호출 동안 process.argv를 바꾸고 출력을 모은다.
async function withArguments(ids, body) {
  const argv = process.argv;
  const log = console.log;
  const lines = [];
  process.argv = [argv[0], 'x.mjs', ...ids];
  console.log = line => lines.push(line);
  try { await body(); } finally {
    process.argv = argv;
    console.log = log;
  }
  return lines;
}

const run = cases();
await run.run('coverage_case/runs-requested-cases-in-order', COMPUTE, async () => {
  const ran = [];
  const lines = await withArguments(['b', 'a'], () => runCases('x.mjs', { a: async () => ran.push('a'), b: async () => ran.push('b') }, 1000));
  assert.deepEqual(ran, ['b', 'a']);
  assert.deepEqual(lines, ['CASE b PASS', 'CASE a PASS']);
});
await run.run('coverage_case/refuses-repeated-and-unknown-ids', COMPUTE, async () => {
  for (const ids of [['a', 'a'], ['z']])
    await assert.rejects(withArguments(ids, () => runCases('x.mjs', { a: async () => {} }, 1000)), /^Error: usage: x\.mjs a\.\.\.; got /);
});
// Without a case ID, runCases registers each case of the suite as a top-level node:test test named by its ID.
await run.run('coverage_case/registers-the-suite-without-ids', COMPUTE, () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-case-'));
  try {
    const file = join(directory, 'suite.mjs');
    writeFileSync(file, `import { runCases } from ${JSON.stringify(new URL('./coverage_case.mjs', import.meta.url).href)};\n` +
      "await runCases('suite.mjs', { only: async () => {} }, 1000, { b: async () => {}, a: async () => { throw new Error('a fails'); } });\n");
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual([...result.stdout.matchAll(/^(not ok|ok) \d+ - (\S+)$/gm)].map(m => [m[1], m[2]]), [['ok', 'b'], ['not ok', 'a']]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
await run.run('coverage_case/stops-a-case-at-its-deadline', COMPUTE, async () => {
  let timer;
  await assert.rejects(withArguments(['slow'], async () => {
    try {
      await runCases('x.mjs', { slow: () => new Promise(resolve => { timer = setTimeout(resolve, 5000); }) }, 20);
    } finally { clearTimeout(timer); }
  }), /case slow exceeded 20 ms/);
});
await run.run('coverage_case/resolves-each-listed-database', COMPUTE, () => {
  const file = 'packages/ts/tests/a.mjs';
  const command = (dsn_env) => [{ runner: 'node', test: file, cases: ['c'], dsn_env }];
  const manifest = { features: [{ id: 'x', coverage: { kind: 'database', cases: ['c'], owners: { typescript: { part: 'packages/ts', tests: [file],
    commands: { sqlite: command('DSN_S'), mysql: command('DSN_M') } } } } }] };
  assert.throws(() => coverageItems(manifest, file, { DSN_S: 'sqlite:///x' }), /DSN_M/);
  assert.deepEqual(coverageItems(manifest, file, { DSN_S: 's', DSN_M: 'm' }).map(item => [item.database, item.dsn]),
    [['sqlite', 's'], ['mysql', 'm']]);
  assert.deepEqual(coverageItems(manifest, 'packages/ts/tests/none.mjs', {}), []);
});
await run.run('coverage_case/reports-error-codes-and-cleanup-failures', COMPUTE, async () => {
  assert.equal(await errorCode(Promise.reject(Object.assign(new Error('bad'), { code: 'CONFIG' }))), 'CONFIG');
  assert.equal(await errorCode(Promise.resolve()), null);
  await assert.rejects(errorCode(Promise.reject(new Error('no code'))), /no code/);
  let cleaned = false;
  await withCleanup(async () => {}, async () => { cleaned = true; });
  assert.equal(cleaned, true);
  await assert.rejects(withCleanup(async () => { throw new Error('body'); }, async () => { throw new Error('cleanup'); }),
    error => error instanceof AggregateError && error.errors.map(item => item.message).join(',') === 'body,cleanup');
});
run.finish();
