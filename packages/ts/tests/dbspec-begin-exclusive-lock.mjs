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
  return {
    exec(sql) {
      if (sql === 'BEGIN EXCLUSIVE') throw beginError;
    },
    prepare(sql) {
      const values = {
        'PRAGMA foreign_keys': [1],
        'PRAGMA legacy_alter_table': [0],
        'PRAGMA busy_timeout': [5000],
        'PRAGMA locking_mode': ['normal'],
        'SELECT COUNT(*) FROM sqlite_master': [0],
      }[sql];
      return { setReturnArrays() {}, all: () => [values], run: () => ({}) };
    },
  };
}

async function checkCode(code, locked) {
  const cause = new Error(`synthetic SQLite result ${code}`);
  cause.errcode = code;
  await assert.rejects(applyPlans(failingSqlite(cause), 'sqlite', plans, () => 0), error => {
    if (locked) return error instanceof DbspecApplyError && error.code === 'locked' && error.cause === cause;
    return error === cause;
  });
}

caseTest('dbspec/begin-exclusive/primary-and-extended-lock-codes', COMPUTE, async () => {
  for (const code of [5, 6, 261, 517, 773, 262, 518]) await checkCode(code, true);
});

caseTest('dbspec/begin-exclusive/non-lock-errors-preserve-identity', COMPUTE, async () => {
  for (const code of [10, 8, 14, 23, 1]) await checkCode(code, false);
  for (const cause of [new Error('database is locked'), Object.assign(new Error('missing code'), { errcode: null })]) {
    await assert.rejects(applyPlans(failingSqlite(cause), 'sqlite', plans, () => 0), error => error === cause);
  }
});
