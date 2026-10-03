// dbspec apply cleanup errors (docs/plans.md "Apply"): a wrapped SQLite
// database injects a failing lock release after an event stops apply and a
// failing foreign key restore after a failing BEGIN EXCLUSIVE, and a scripted
// MySQL connection returns no row for an effect query. Apply must
// reject with every error: the first failure alone, or an AggregateError
// whose errors are the first failure and then the cleanup errors in order.
//
// Usage: node --test clients/typescript/tests/dbspec-apply-cleanup.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DbspecApplyError, applyPlans, parsePlan } from '../dist/dbspec/index.js';
import { EFFECT_QUERIES, dbspecEffectHolds } from '../dist/dbspec/apply.js';

const root = new URL('../../../', import.meta.url);
// TIMEOUT은 case 하나의 기한(ms)이다. apply의 정리 error case 하나는 memory SQLite database 하나에 plan 하나를 적용한다.
const TIMEOUT = 20000;
// tool clock: 2026-10-01T00:00:00.123456789Z를 microsecond로 자른 값(epoch 이후 microsecond)이다.
const fixedNow = () => Date.UTC(2026, 9, 1, 0, 0, 0) * 1000 + 123456;

const plans = JSON.parse(readFileSync(new URL('tests/dbspec/plans.json', root), 'utf8'))
  .cases.filter(c => c.id === 'create-from-empty')
  .map(c => {
    const parsed = parsePlan(c.plan.join('\n') + '\n');
    assert.deepEqual(parsed.diagnostics, [], `${c.id} diagnostics`);
    return parsed.plan;
  });
assert.equal(plans.length, 1, 'plans.json has no create-from-empty case');

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
function vector(name, body) {
  caseTest(name, TIMEOUT, body);
}

// failingSqlite는 memory SQLite database를 감싸서 fail의 statement를 exec하면 그 error를 던진다.
function failingSqlite(fail) {
  const db = new DatabaseSync(':memory:');
  return {
    exec(sql) {
      if (fail.has(sql)) throw fail.get(sql);
      return db.exec(sql);
    },
    prepare: sql => db.prepare(sql),
    close: () => db.close(),
  };
}

// wantCleanup은 promise가 failure를 처음 error로, cleanup을 그 뒤 error로 가진 AggregateError로 실패하는지 확인한다.
async function wantCleanup(promise, failure, cleanup) {
  await assert.rejects(promise, error => {
    assert(error instanceof AggregateError, `${error} alone; want it with the cleanup errors`);
    assert(failure(error.errors[0]), `first error ${error.errors[0]}`);
    assert.deepEqual(error.errors.slice(1), cleanup, 'cleanup errors');
    console.log(`  ${error.errors.map(e => e.message).join('; ')}`);
    return true;
  });
}

vector('apply/cleanup-errors/release', async () => {
  const stop = new Error('stop');
  const release = new Error('release failed');
  const db = failingSqlite(new Map([['PRAGMA locking_mode = normal', release]]));
  try {
    const events = event => {
      if (event.kind === 'applied') throw stop;
    };
    await wantCleanup(applyPlans(db, 'sqlite', plans, fixedNow, events), e => e === stop, [release]);
  } finally {
    db.close();
  }
});

vector('apply/cleanup-errors/begin-restore', async () => {
  const begin = new Error('begin failed');
  const restore = new Error('restore failed');
  // node:sqlite는 foreign key를 켠 채 연다.
  const db = failingSqlite(new Map([['BEGIN EXCLUSIVE', begin], ['PRAGMA foreign_keys = 1', restore]]));
  try {
    await wantCleanup(
      applyPlans(db, 'sqlite', plans, fixedNow, null),
      e => e instanceof DbspecApplyError && e.code === 'locked' && e.cause === begin,
      [restore],
    );
  } finally {
    db.close();
  }
});

vector('apply/effect-row', async () => {
  // 효과 query가 row를 돌려주지 않는 scripted MySQL connection이다.
  const tables = EFFECT_QUERIES.mysql.table;
  const connection = {
    async query(q) {
      const sql = typeof q === 'string' ? q : q.sql;
      if (sql !== tables) throw new Error(`unexpected query ${sql}`);
      return [[], []];
    },
  };
  await assert.rejects(dbspecEffectHolds(connection, 'mysql', { kind: 'table', table: 'orders', name: '', present: true }), error => {
    assert.equal(error.message, `${tables} returned no row`);
    console.log(`  ${error.message}`);
    return true;
  });
});
