// feature coverage case 실행부(clients/typescript/tests/coverage_case.mjs)의 unit test다. 실행부는
// TypeScript coverage test가 함께 쓰므로, 그 변경은 모든 기능의 coverage가 아니라 이 test가
// 검사한다(contracts/features.json의 helpers). 전체 coverage는 make check가 실행한다.
// Usage: node clients/typescript/tests/coverage-case-unit.mjs
import assert from 'node:assert/strict';
import { errorCode, featureDatabase, runCases, withCleanup } from './coverage_case.mjs';
import { cases, COMPUTE } from '../../../tests/testcase.mjs';

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
await run.run('coverage_case/refuses-missing-repeated-and-unknown-ids', COMPUTE, async () => {
  for (const ids of [[], ['a', 'a'], ['z']])
    await assert.rejects(withArguments(ids, () => runCases('x.mjs', { a: async () => {} }, 1000)), /^Error: usage: x\.mjs a\.\.\.; got /);
});
await run.run('coverage_case/stops-a-case-at-its-deadline', COMPUTE, async () => {
  let timer;
  await assert.rejects(withArguments(['slow'], async () => {
    try {
      await runCases('x.mjs', { slow: () => new Promise(resolve => { timer = setTimeout(resolve, 5000); }) }, 20);
    } finally { clearTimeout(timer); }
  }), /case slow exceeded 20 ms/);
});
await run.run('coverage_case/requires-the-selected-database', COMPUTE, () => {
  const saved = { ...process.env };
  try {
    delete process.env.ORM_FEATURE_DATABASE;
    delete process.env.ORM_FEATURE_DSN;
    assert.throws(() => featureDatabase(), /ORM_FEATURE_DATABASE \(mysql\|postgres\|sqlite\) and ORM_FEATURE_DSN are required/);
    process.env.ORM_FEATURE_DATABASE = 'sqlite';
    process.env.ORM_FEATURE_DSN = 'sqlite:///tmp/x.sqlite';
    assert.deepEqual(featureDatabase(), { driver: 'sqlite', dsn: 'sqlite:///tmp/x.sqlite' });
  } finally {
    for (const key of ['ORM_FEATURE_DATABASE', 'ORM_FEATURE_DSN']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
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
