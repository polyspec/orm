import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { DbspecApplyError, applyPlans, parsePlan } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const plans = JSON.parse(readFileSync(new URL('tests/dbspec/plans.json', root), 'utf8'))
  .cases.filter(testCase => testCase.id === 'create-from-empty')
  .map(testCase => parsePlan(testCase.plan.join('\n') + '\n').plan);
assert.equal(plans.length, 1);

function failingSqlite(beginError) {
  const pragmas = { foreign_keys: 1, legacy_alter_table: 1, busy_timeout: 1300, locking_mode: 'normal' };
  const unexpected = [];
  const operations = [];
  return {
    pragmas,
    unexpected,
    operations,
    exec(sql) {
      operations.push(sql);
      if (sql === 'BEGIN EXCLUSIVE') throw beginError;
      const setting = /^PRAGMA (foreign_keys|legacy_alter_table|busy_timeout|locking_mode) = (.+)$/.exec(sql);
      if (setting === null) {
        unexpected.push(sql);
      } else {
        pragmas[setting[1]] = setting[1] === 'locking_mode' ? setting[2].toLowerCase() : Number(setting[2]);
      }
    },
    prepare(sql) {
      operations.push(`QUERY ${sql}`);
      const values = {
        'PRAGMA foreign_keys': [pragmas.foreign_keys],
        'PRAGMA legacy_alter_table': [pragmas.legacy_alter_table],
        'PRAGMA busy_timeout': [pragmas.busy_timeout],
        'PRAGMA locking_mode': [pragmas.locking_mode],
        'SELECT COUNT(*) FROM sqlite_master': [0],
      }[sql];
      if (values === undefined) throw new Error(`unexpected SQLite lock-test query: ${sql}`);
      return { setReturnArrays() {}, all: () => [values], run: () => ({}) };
    },
  };
}

function assertRestored(sqlite) {
  assert.deepEqual(sqlite.pragmas, { foreign_keys: 1, legacy_alter_table: 1, busy_timeout: 1300, locking_mode: 'normal' });
  assert.deepEqual(sqlite.unexpected, []);
  assert.deepEqual(sqlite.operations, [
    'QUERY PRAGMA foreign_keys',
    'QUERY PRAGMA legacy_alter_table',
    'QUERY PRAGMA busy_timeout',
    'QUERY PRAGMA locking_mode',
    'PRAGMA busy_timeout = 5000',
    'PRAGMA locking_mode = EXCLUSIVE',
    'BEGIN EXCLUSIVE',
    'PRAGMA foreign_keys = 1',
    'PRAGMA legacy_alter_table = 1',
    'PRAGMA locking_mode = normal',
    'QUERY SELECT COUNT(*) FROM sqlite_master',
    'PRAGMA busy_timeout = 1300',
  ]);
}

async function checkCode(code, locked) {
  const cause = new Error(`synthetic SQLite result ${code}`);
  cause.errcode = code;
  const sqlite = failingSqlite(cause);
  await assert.rejects(applyPlans(sqlite, 'sqlite', plans, () => 0), error => {
    if (locked) return error instanceof DbspecApplyError && error.code === 'locked' && error.cause === cause;
    return error === cause;
  });
  assertRestored(sqlite);
}

// Requirements: PLN-89, PLN-90.
caseTest('dbspec/begin-exclusive/primary-and-extended-lock-codes', COMPUTE, async () => {
  for (const code of [5, 6, 261, 517, 773, 262, 518]) await checkCode(code, true);
});

// Requirements: PLN-89, PLN-90.
caseTest('dbspec/begin-exclusive/non-lock-errors-preserve-identity', COMPUTE, async () => {
  for (const code of [10, 8, 14, 23, 1]) await checkCode(code, false);
  for (const cause of [new Error('database is locked'), Object.assign(new Error('missing code'), { errcode: null })]) {
    const sqlite = failingSqlite(cause);
    await assert.rejects(applyPlans(sqlite, 'sqlite', plans, () => 0), error => error === cause);
    assertRestored(sqlite);
  }
});
