// dbspec apply cleanup errors (docs/plans.md "Apply"): a wrapped SQLite
// database injects a failing ROLLBACK after an event stops apply and a
// failing foreign key restore after a failing BEGIN IMMEDIATE, and a scripted
// MySQL connection returns no row for a recovery effect query. Apply must
// reject with every error: the first failure alone, or an AggregateError
// whose errors are the first failure and then the cleanup errors in order.
//
// Usage: node --test clients/typescript/tests/dbspec-apply-cleanup.mjs (after the build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { DbspecApplyError, applyPlans, parsePlan, recoverPlans } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const TIMEOUT = 5000;
const fixedNow = () => new Date(Date.UTC(2026, 9, 1, 0, 0, 0));

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
  test(name, { timeout: TIMEOUT }, async () => {
    const started = performance.now();
    console.log(`start ${name}`);
    try {
      await body();
    } catch (error) {
      console.log(`result ${name}: FAIL after ${(performance.now() - started).toFixed(1)} ms`);
      throw error;
    }
    console.log(`result ${name}: PASS after ${(performance.now() - started).toFixed(1)} ms`);
  });
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

vector('apply/cleanup-errors/rollback', async () => {
  const stop = new Error('stop');
  const rollback = new Error('rollback failed');
  const db = failingSqlite(new Map([['ROLLBACK', rollback]]));
  try {
    const events = event => {
      if (event.kind === 'applied') throw stop;
    };
    await wantCleanup(applyPlans(db, 'sqlite', plans, fixedNow, events), e => e === stop, [rollback]);
  } finally {
    db.close();
  }
});

vector('apply/cleanup-errors/begin-restore', async () => {
  const begin = new Error('begin failed');
  const restore = new Error('restore failed');
  const db = failingSqlite(new Map([['BEGIN IMMEDIATE', begin], ['PRAGMA foreign_keys = ON', restore]]));
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

vector('apply/mysql-effect-row', async () => {
  // recover가 읽는 query마다 정한 row를 돌려주는 MySQL connection이다. 효과 query는 row를 돌려주지 않는다.
  const tables = 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?';
  const history = 'SELECT `name`, `from_hash`, `to_hash`, `state`, `step` FROM `dbspec$plans`';
  const script = new Map([
    ["SELECT GET_LOCK('dbspec$plans', 0)", [[1]]],
    [history, [[plans[0].name, 'empty', plans[0].to, 'running', 0]]],
    [tables, []],
  ]);
  const connection = {
    async query(q) {
      const sql = typeof q === 'string' ? q : q.sql;
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS `dbspec$plans`') || sql === "DO RELEASE_LOCK('dbspec$plans')") return [{}, []];
      if (!script.has(sql)) throw new Error(`unexpected query ${sql}`);
      return [script.get(sql), []];
    },
  };
  await assert.rejects(recoverPlans(connection, 'mysql', plans, fixedNow, null), error => {
    assert(error instanceof DbspecApplyError && error.code === 'failed' && error.step === 0, `${error}; want failed at step 0`);
    assert.equal(error.cause?.message, `${tables} returned 0 rows`);
    console.log(`  ${error.message}`);
    return true;
  });
});
