import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { caseTest, COMPUTE } from '../tests/testcase.mts';
import { reportUnchangedState, runPhysicalCommandCase } from './physical-command-case.mts';
import { command, commandEnvironment, observed } from './decimal-physical-check.mts';

const kitRunTests = fileURLToPath(import.meta.resolve('@polyspec/kit/run-tests'));

caseTest('dispatches each decimal owner to its native command and rejects unknown runtimes', COMPUTE, () => {
  const extension = '/build/polyspec_orm.so';
  const cases = [
    ['go', 'go', ['test', '-json']],
    ['php', 'php', ['vendor-php/bin/phpunit']],
    ['php-extension', process.execPath, [kitRunTests, 'phpunit']],
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

caseTest('matches the exact PHP decimal PHPUnit class and data-set events', COMPUTE, () => {
  const database = 'mysql';
  const classSuite = "##teamcity[testSuiteStarted name='Polyspec\\Orm\\Tests\\DecimalModelDbTest']";
  const finished = ['testGenerate', 'testSetters', 'testRoundTrip']
    .map(name => `##teamcity[testFinished name='${name} with data set "${database}"']`)
    .join('\n');
  const output = ["##teamcity[testCount count='3']", classSuite, finished].join('\n');
  assert.equal(observed('php', database, output), true);
  assert.equal(observed('php', database, output.replace('DecimalModelDbTest', 'OtherTest')), false);
  assert.equal(observed('php', database, output.replace('testRoundTrip', 'test_round_trip')), false);
  assert.equal(observed('php', database, `${output}\n##teamcity[testFailed name='testSetters']`), false);
});

caseTest('matches both exact TypeScript decimal node:test pass events', COMPUTE, () => {
  const output = [
    '✔ decimal_db/mysql/setters (0.317458ms)',
    '✔ decimal_db/mysql/round_trip (0.0525ms)',
    'ℹ tests 2',
    'ℹ suites 0',
    'ℹ pass 2',
    'ℹ fail 0',
    'ℹ cancelled 0',
    'ℹ skipped 0',
  ].join('\n');
  assert.equal(observed('typescript', 'mysql', output), true);
  assert.equal(observed('typescript', 'mysql', output.replace('ℹ fail 0', 'ℹ fail 1')), false);
  assert.equal(observed('typescript', 'mysql', output.replace('✔ decimal_db/mysql/round_trip', '✖ decimal_db/mysql/round_trip')), false);
  assert.equal(observed('typescript', 'mysql', output.replace('ℹ tests 2', 'ℹ tests 1')), false);
  assert.equal(observed('typescript', 'mysql', `${output}\n✔ decimal_db/mysql/unexpected (0.1ms)`), false);
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
