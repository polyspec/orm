import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { reportUnchangedState, runPhysicalCommandCase } from './physical-command-case.mts';

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
  await assert.rejects(runPhysicalCommandCase(async () => 'not accepted', 'node', [], {}, 'dsn-secret',
    { kind: 'predicate', accepts: output => output === 'accepted' }, 'missing predicate output'), /missing predicate output/);
});

test('redacts the DSN from command failures', async () => {
  const cause = new TypeError('failed for dsn-secret');
  cause.stack = `${cause.stack}\ncommand context dsn-secret`;
  Object.assign(cause, { stderr: 'driver reported dsn-secret' });
  await assert.rejects(runPhysicalCommandCase(async () => { throw cause; }, 'php', [], {}, 'dsn-secret',
    { kind: 'teamcity', testName: 'test_group_rows' }, 'missing pass event'), error => {
    assert(error instanceof Error);
    assert.equal(error.message, 'failed for [redacted]');
    assert.equal(error.message.includes('dsn-secret'), false);
    assert(error.cause instanceof TypeError);
    assert.equal(error.cause.message, 'failed for [redacted]');
    assert.equal(error.cause.stack?.includes('command context [redacted]'), true);
    assert('stderr' in error.cause);
    assert.equal(error.cause.stderr, 'driver reported [redacted]');
    assert.equal(inspect(error).includes('dsn-secret'), false);
    return true;
  });
});

test('reports the matching database state and rejects a changed state', async () => {
  const messages: string[] = [];
  await reportUnchangedState(async () => 'state-hash', 'state-hash', 'state changed', message => messages.push(message));
  assert.deepEqual(messages, ['state state-hash']);
  await assert.rejects(reportUnchangedState(async () => 'changed-hash', 'state-hash', 'state changed', () => {}), /state changed/);
});
