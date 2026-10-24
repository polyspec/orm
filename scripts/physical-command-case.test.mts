import assert from 'node:assert/strict';
import test from 'node:test';
import { runPhysicalCommandCase } from './physical-command-case.mts';

test('accepts the expected TeamCity pass event', async () => {
  await runPhysicalCommandCase(async () => "##teamcity[testFinished name='test_group_rows']", 'php', [], {}, 'dsn-secret',
    { kind: 'teamcity', testName: 'test_group_rows' }, 'missing pass event');
});

test('rejects a failed or unexpected TeamCity event and nonmatching exact output', async () => {
  const run = async () => "##teamcity[testFinished name='test_group_rows']\n##teamcity[testFailed name='test_group_rows']";
  await assert.rejects(runPhysicalCommandCase(run, 'php', [], {}, 'dsn-secret',
    { kind: 'teamcity', testName: 'test_group_rows' }, 'missing pass event'), /missing pass event/);
  await assert.rejects(runPhysicalCommandCase(async () => 'CASE other PASS', 'node', [], {}, 'dsn-secret',
    { kind: 'exact', output: 'CASE group_rows_mysql PASS' }, 'missing exact output'), /missing exact output/);
});

test('redacts the DSN from command failures', async () => {
  await assert.rejects(runPhysicalCommandCase(async () => { throw new Error('failed for dsn-secret'); }, 'php', [], {}, 'dsn-secret',
    { kind: 'teamcity', testName: 'test_group_rows' }, 'missing pass event'), error => {
    assert(error instanceof Error);
    assert.equal(error.message, 'failed for [redacted]');
    assert.equal(error.message.includes('dsn-secret'), false);
    return true;
  });
});
