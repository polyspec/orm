import assert from 'node:assert/strict';
import { caseTest } from '../../../tests/testcase.mts';
import { registerDatabaseCases } from './database-case-tests.mjs';

caseTest('registers selected database cases in dialect order and runs their fixture', 1000, async () => {
  const registrations = [];
  const events = [];
  let failures = 0;
  registerDatabaseCases({
    feature: 'sample',
    cases: { first: 'first-run', second: 'second-run' },
    args: ['second'],
    environment: { ORM_TEST_MYSQL_DSN: 'mysql://user:pass@localhost', ORM_TEST_POSTGRES_DSN: 'postgres://user:pass@localhost' },
    deadline: 5000,
    getFailures: () => failures,
    setCurrent: current => events.push(`current:${current}`),
    withDatabase: async (driver, step, body) => {
      events.push(`database:${driver}`);
      step(`opened ${driver}`);
      await body({ dsn: `${driver}:dsn` });
    },
    runCase: async (run, name, driver, database) => events.push(`${run}:${name}:${driver}:${database.dsn}`),
    register: (name, deadline, body) => registrations.push({ name, deadline, body }),
  });

  assert.deepEqual(registrations.map(({ name, deadline }) => [name, deadline]), [
    ['sample/second/sqlite', 5000],
    ['sample/second/mysql', 5000],
    ['sample/second/postgres', 5000],
  ]);
  for (const registration of registrations) await registration.body({ step: message => events.push(`step:${message}`) });
  assert.deepEqual(events, [
    'current:second/sqlite', 'database:sqlite', 'step:opened sqlite', 'second-run:second:sqlite:sqlite:dsn',
    'current:second/mysql', 'database:mysql', 'step:opened mysql', 'second-run:second:mysql:mysql:dsn',
    'current:second/postgres', 'database:postgres', 'step:opened postgres', 'second-run:second:postgres:postgres:dsn',
  ]);
});

caseTest('rejects selected database cases that do not exist', 1000, () => {
  assert.throws(() => registerDatabaseCases({
    feature: 'sample', cases: {}, args: ['missing'], environment: { ORM_TEST_MYSQL_DSN: 'mysql://user:pass@localhost', ORM_TEST_POSTGRES_DSN: 'postgres://user:pass@localhost' }, deadline: 5000,
    withDatabase: async () => {}, getFailures: () => 0, setCurrent: () => {}, runCase: () => {}, register: () => {},
  }), { message: 'unknown case missing' });
});

caseTest('names a missing database DSN and the target that provides it', 1000, () => {
  assert.throws(() => registerDatabaseCases({
    feature: 'sample', cases: {}, args: [], environment: { ORM_TEST_MYSQL_DSN: 'mysql://user:pass@localhost' }, deadline: 5000,
    withDatabase: async () => {}, getFailures: () => 0, setCurrent: () => {}, runCase: () => {}, register: () => {},
  }), { message: 'ORM_TEST_POSTGRES_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers' });
});

caseTest('fails a database case when one of its assertions fails', 1000, async () => {
  let failures = 0;
  let run;
  registerDatabaseCases({
    feature: 'sample', cases: { first: () => {} }, args: ['first'], environment: { ORM_TEST_MYSQL_DSN: 'mysql://user:pass@localhost', ORM_TEST_POSTGRES_DSN: 'postgres://user:pass@localhost' }, deadline: 5000,
    getFailures: () => failures, setCurrent: () => {}, withDatabase: async (_driver, _step, body) => body({}),
    runCase: () => { failures++; }, register: (_name, _deadline, body) => { run = body; },
  });
  await assert.rejects(run({ step: () => {} }), { message: '1 check(s) failed; each FAIL line above names one' });
});
