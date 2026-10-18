// Unit test of the feature coverage case runner (packages/ts/tests/coverage_case.mjs). The runner
// is shared with the TypeScript coverage test, so a change to it is checked by this test,
// not by the coverage of every feature (the helpers in contracts/features.json). make check runs the full coverage.
// Usage: node packages/ts/tests/coverage-case-unit.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorCode, runCases, withCleanup } from './coverage_case.mjs';
import { coverageItems } from '../../../scripts/features/coverage.mts';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

// runCases reads the case IDs from the command line, so during each call it changes process.argv and collects the output.
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

caseTest('coverage_case/runs-requested-cases-in-order', COMPUTE, async () => {
  const ran = [];
  const lines = await withArguments(['b', 'a'], () => runCases('x.mjs', { a: async () => ran.push('a'), b: async () => ran.push('b') }, 1000));
  assert.deepEqual(ran, ['b', 'a']);
  assert.deepEqual(lines, ['CASE b PASS', 'CASE a PASS']);
});
caseTest('coverage_case/refuses-repeated-and-unknown-ids', COMPUTE, async () => {
  for (const ids of [['a', 'a'], ['z']])
    await assert.rejects(withArguments(ids, () => runCases('x.mjs', { a: async () => {} }, 1000)), /^Error: usage: x\.mjs a\.\.\.; got /);
});
// Without a case ID, runCases registers each case of the suite as a top-level node:test test named by its ID.
caseTest('coverage_case/registers-the-suite-without-ids', COMPUTE, () => {
  const directory = mkdtempSync(join(tmpdir(), 'coverage-case-'));
  try {
    const file = join(directory, 'suite.mjs');
    writeFileSync(file, `import { runCases } from ${JSON.stringify(new URL('./coverage_case.mjs', import.meta.url).href)};\n` +
      "await runCases('suite.mjs', { only: async () => {} }, 1000, { b: async () => {}, a: async () => { throw new Error('a fails'); } });\n");
    // A separate process without --test: a nested node:test run inside this test is refused by node:test. NODE_TEST_CONTEXT
    // is removed so the child registers and runs its own root tests instead of reporting to this run.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [file], { encoding: 'utf8', env });
    assert.equal(result.status, 1, result.stderr);
    const summary = result.stdout.split(/^ℹ tests /m)[0];
    assert.deepEqual([...summary.matchAll(/^([✔✖]) (\S+) \(/gmu)].map(m => [m[1] === '✔' ? 'ok' : 'not ok', m[2]]), [['ok', 'b'], ['not ok', 'a']]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
caseTest('coverage_case/stops-a-case-at-its-deadline', COMPUTE, async () => {
  let timer;
  await assert.rejects(withArguments(['slow'], async () => {
    try {
      await runCases('x.mjs', { slow: () => new Promise(resolve => { timer = setTimeout(resolve, 5000); }) }, 20);
    } finally { clearTimeout(timer); }
  }), /case slow exceeded 20 ms/);
});
caseTest('coverage_case/resolves-each-listed-database', COMPUTE, () => {
  const file = 'packages/ts/tests/a.mjs';
  const command = (dsn_env) => [{ runner: 'node', test: file, cases: ['c'], dsn_env }];
  const manifest = { features: [{ id: 'x', coverage: { kind: 'database', cases: ['c'], owners: { typescript: { part: 'packages/ts', tests: [file],
    commands: { sqlite: command('DSN_S'), mysql: command('DSN_M') } } } } }] };
  assert.throws(() => coverageItems(manifest, file, { DSN_S: 'sqlite:///x' }), /DSN_M/);
  assert.deepEqual(coverageItems(manifest, file, { DSN_S: 's', DSN_M: 'm' }).map(item => [item.database, item.dsn]),
    [['sqlite', 's'], ['mysql', 'm']]);
  assert.deepEqual(coverageItems(manifest, 'packages/ts/tests/none.mjs', {}), []);
});
caseTest('coverage_case/reports-error-codes-and-cleanup-failures', COMPUTE, async () => {
  assert.equal(await errorCode(Promise.reject(Object.assign(new Error('bad'), { code: 'CONFIG' }))), 'CONFIG');
  assert.equal(await errorCode(Promise.resolve()), null);
  await assert.rejects(errorCode(Promise.reject(new Error('no code'))), /no code/);
  let cleaned = false;
  await withCleanup(async () => {}, async () => { cleaned = true; });
  assert.equal(cleaned, true);
  await assert.rejects(withCleanup(async () => { throw new Error('body'); }, async () => { throw new Error('cleanup'); }),
    error => error instanceof AggregateError && error.errors.map(item => item.message).join(',') === 'body,cleanup');
});
