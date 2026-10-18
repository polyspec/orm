// dbspec apply cleanup errors (docs/plans.md "Apply"): a wrapped SQLite
// database injects a failing lock release after an event stops apply and a
// failing foreign key restore after a failing BEGIN EXCLUSIVE, and a scripted
// MySQL connection returns no row for an effect query. Apply must
// reject with every error: the first failure alone, or an AggregateError
// whose errors are the first failure and then the cleanup errors in order.
//
// Usage: node --test packages/ts/tests/dbspec-apply-cleanup.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DbspecApplyError, applyPlans, parsePlan, rollbackPlans } from '../dist/dbspec/index.js';
import { EFFECT_QUERIES, dbspecEffectHolds } from '../dist/dbspec/apply.js';

const root = new URL('../../../', import.meta.url);
// TIMEOUT is the deadline (ms) of one case. One apply cleanup error case applies one plan to one in-memory SQLite database.
const TIMEOUT = 20000;
// tool clock: 2026-10-01T00:00:00.123456789Z truncated to microseconds (microseconds since the epoch).
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

// failingSqlite wraps an in-memory SQLite database and throws that error when the fail statement is executed.
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

// wantCleanup checks that the promise fails with an AggregateError whose first error is the failure and whose following error is the cleanup.
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
  // node:sqlite opens with foreign keys turned on.
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

vector('apply/rollback-step-outside', async () => {
  // If the step of an applied row is outside the plan's steps, rollback does not read the step and stops with a chain error.
  const db = failingSqlite(new Map());
  try {
    await applyPlans(db, 'sqlite', plans, fixedNow, null);
    db.exec('UPDATE "dbspec$plans" SET step = 99');
    await assert.rejects(rollbackPlans(db, 'sqlite', plans, fixedNow, null), error => {
      assert(error instanceof DbspecApplyError && error.code === 'chain', `${error}; want a chain error`);
      assert.match(error.message, /the recorded step 99 is outside the plan's 4 steps/);
      console.log(`  ${error.message}`);
      return true;
    });
  } finally {
    db.close();
  }
});

vector('apply/effect-row', async () => {
  // A scripted MySQL connection whose effect query returns no row.
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
