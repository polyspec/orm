import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { caseTest, COMPUTE } from '../tests/testcase.mts';
import { reportUnchangedState, runPhysicalCommandCase } from './physical-command-case.mts';
import { command, commandEnvironment } from './decimal-physical-check.mts';

caseTest('dispatches each decimal owner to its native command and rejects unknown runtimes', COMPUTE, () => {
  const extension = '/build/polyspec_orm.so';
  const cases = [
    ['go', 'go', ['test', '-json']],
    ['php', 'php', ['vendor-php/bin/phpunit']],
    ['php-extension', process.execPath, ['node_modules/@polyspec/kit/scripts/kit/run-tests.mts', 'phpunit']],
    ['rust', 'cargo', ['test', '--offline']],
    ['python', '/venv/bin/python', ['-m', 'packages.python.tests.decimal_model_db']],
    ['typescript', 'node', ['packages/ts/tests/decimal_model_db.mjs']],
  ] as const;
  for (const [language, expectedProgram, expectedArgs] of cases) {
    const [program, args] = command(language, 'postgres', { POLYSPEC_ORM_EXTENSION: extension, ORM_PYTHON: '/venv/bin/python' });
    assert.equal(program, expectedProgram, `${language} program`);
    assert.deepEqual(args.slice(0, expectedArgs.length), expectedArgs, `${language} command`);
  }

  const [extensionProgram, extensionArgs] = command('php-extension', 'postgres', { POLYSPEC_ORM_EXTENSION: extension });
  assert.equal(extensionProgram, process.execPath);
  assert.ok(extensionArgs.includes(extension));
  assert.ok(extensionArgs.includes('--without-library'));
  assert.ok(extensionArgs.includes('packages/php-ext/phpunit.xml.dist'));
  assert.ok(extensionArgs.includes('packages/php-ext/tests/DecimalModelDbNativeTest.php'));
  assert.ok(extensionArgs.includes('--filter'));
  assert.ok(extensionArgs.includes('with data set "postgres"$'));
  assert.equal(extensionArgs.includes('packages/ts/tests/decimal_model_db.mjs'), false);
  assert.equal(commandEnvironment('php-extension', { PATH: '/bin' }).ORM_PHP_MODE, 'extension');
  assert.equal(commandEnvironment('php', { PATH: '/bin' }).ORM_PHP_MODE, undefined);
  assert.throws(() => command('unknown-runtime', 'postgres', {}), /unknown decimal physical runtime/);
});

caseTest('accepts the expected TeamCity pass event', COMPUTE, async () => {
  await runPhysicalCommandCase(async () => "##teamcity[testFinished name='test_group_rows']", 'php', [], {}, 'dsn-secret',
    { kind: 'teamcity', testName: 'test_group_rows' }, 'missing pass event');
});

caseTest('rejects a failed or unexpected TeamCity event and nonmatching exact output', COMPUTE, async () => {
  const run = async () => "##teamcity[testFinished name='test_group_rows']\n##teamcity[testFailed name='test_group_rows']";
  await assert.rejects(runPhysicalCommandCase(run, 'php', [], {}, 'dsn-secret',
    { kind: 'teamcity', testName: 'test_group_rows' }, 'missing pass event'), /missing pass event/);
  await assert.rejects(runPhysicalCommandCase(async () => 'CASE other PASS', 'node', [], {}, 'dsn-secret',
    { kind: 'exact', output: 'CASE group_rows_mysql PASS' }, 'missing exact output'), /missing exact output/);
  await assert.rejects(runPhysicalCommandCase(async () => 'not accepted', 'node', [], {}, 'dsn-secret',
    { kind: 'predicate', accepts: output => output === 'accepted' }, 'missing predicate output'), /missing predicate output/);
});

caseTest('redacts the DSN from command failures', COMPUTE, async () => {
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

caseTest('reports the matching database state and rejects a changed state', COMPUTE, async () => {
  const messages: string[] = [];
  await reportUnchangedState(async () => 'state-hash', 'state-hash', 'state changed', message => messages.push(message));
  assert.deepEqual(messages, ['state state-hash']);
  await assert.rejects(reportUnchangedState(async () => 'changed-hash', 'state-hash', 'state changed', () => {}), /state changed/);
});
