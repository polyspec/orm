import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { caseTest } from '../../../../tests/testcase.mts';
import { Db } from '../dist/database.js';
import { onSqliteConnections } from './case-database.mjs';

async function withDatabase(name, run) {
  const directory = await mkdtemp(join(tmpdir(), 'orm-transaction-failure-'));
  let db;
  try {
    db = await Db.connect(`sqlite://${join(directory, name)}`);
    await run(db);
  } finally {
    await db?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// Requirements: INT-72.
caseTest('transaction-failure/rollback-primary-and-cleanup', async () => {
  await withDatabase('rollback.sqlite', async db => {
    onSqliteConnections(db, state => {
      const statement = state.statement.bind(state);
      state.statement = sql => {
        const prepared = statement(sql);
        if (sql !== 'ROLLBACK') return prepared;
        return {
          run: (...values) => {
            prepared.run(...values);
            throw new Error('rollback rejected by the test driver');
          },
        };
      };
    });
    const callback = new Error('transaction callback failed');
    await assert.rejects(db.transaction(async () => { throw callback; }, { retry: 0 }), error => {
      assert.equal(error.code, 'ROLLBACK');
      assert.equal(error.cause, callback);
      assert.equal(error.rollback.message, 'DRIVER: sqlite: rollback rejected by the test driver');
      return true;
    });
  });
});

// Requirements: PLN-17.
caseTest('transaction-failure/savepoint-end-attempts-both', async () => {
  const scenarios = [
    { name: 'rollback-only', rejected: ['ROLLBACK TO SAVEPOINT '], count: 1 },
    { name: 'release-only', rejected: ['RELEASE SAVEPOINT '], count: 1 },
    { name: 'both-endpoints', rejected: ['ROLLBACK TO SAVEPOINT ', 'RELEASE SAVEPOINT '], count: 2 },
  ];
  for (const scenario of scenarios) {
    await withDatabase(`${scenario.name}.sqlite`, async db => {
      const callback = new Error('savepoint callback failed');
      const controls = [];
      await db.transaction(async () => {
        const session = db.utils().active('transaction').session;
        const control = session.control.bind(session);
        session.control = (sql, params, done) => {
          if (sql.startsWith('SAVEPOINT ') || sql.startsWith('ROLLBACK TO SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')) {
            controls.push(sql);
          }
          if (scenario.rejected.some(prefix => sql.startsWith(prefix))) {
            return Promise.reject(new Error('savepoint end rejected by the test driver'));
          }
          return control(sql, params, done);
        };
        try {
          await assert.rejects(db.transaction(async () => { throw callback; }), error => {
            assert.equal(error.code, 'ROLLBACK', scenario.name);
            assert.equal(error.cause, callback, scenario.name);
            if (scenario.count === 2) {
              assert.equal(error.rollback.code, 'CONFIG', scenario.name);
            } else {
              assert.ok(error.rollback instanceof Error, scenario.name);
              assert.equal(error.rollback.message, 'savepoint end rejected by the test driver', scenario.name);
            }
            assert.equal(error.rollback.message.match(/savepoint end rejected by the test driver/g)?.length, scenario.count, scenario.name);
            return true;
          });
        } finally {
          session.control = control;
        }
      }, { retry: 0 });
      assert.deepEqual(controls, [
        'SAVEPOINT orm_sp_1',
        'ROLLBACK TO SAVEPOINT orm_sp_1',
        'RELEASE SAVEPOINT orm_sp_1',
      ], scenario.name);
    });
  }

  await withDatabase('success-release-only.sqlite', async db => {
    const controls = [];
    await db.transaction(async () => {
      const session = db.utils().active('transaction').session;
      const control = session.control.bind(session);
      session.control = (sql, params, done) => {
        if (sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')) controls.push(sql);
        if (sql.startsWith('RELEASE SAVEPOINT ')) {
          return Promise.reject(new Error('savepoint end rejected by the test driver'));
        }
        return control(sql, params, done);
      };
      try {
        await assert.rejects(db.transaction(async () => {}), error => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /savepoint end rejected by the test driver/);
          assert.doesNotMatch(error.message, /savepoint callback failed/);
          return true;
        });
      } finally {
        session.control = control;
      }
    }, { retry: 0 });
    assert.deepEqual(controls, ['SAVEPOINT orm_sp_1', 'RELEASE SAVEPOINT orm_sp_1']);
  });
});

// Requirements: CORE-24, INT-43, INT-48. A deadlock is retried with no wait between the attempts: the retry sets no timer,
// so the test counts the calls of setTimeout while the transaction runs and measures no time (FCV-2: the wait is visible
// only at this seam). The causes of the error are the cases of the recipe transactions.
caseTest('transaction-failure/deadlock-retry-without-wait', async () => {
  await withDatabase('retry.sqlite', async db => {
    const { transactionConflict } = await import('../dist/index.js');
    let attempts = 0;
    let timers = 0;
    let failure;
    const setTimeoutOfTheProcess = globalThis.setTimeout;
    globalThis.setTimeout = (...args) => {
      timers++;
      return setTimeoutOfTheProcess(...args);
    };
    try {
      await db.transaction(async () => {
        attempts++;
        throw transactionConflict(`attempt ${attempts}`);
      }, { retry: 2 });
    } catch (error) {
      failure = error;
    } finally {
      globalThis.setTimeout = setTimeoutOfTheProcess;
    }
    assert.equal(attempts, 3, 'retry 2 runs the callback three times');
    assert.equal(timers, 0, 'no attempt waits before it runs');
    assert.equal(failure?.code, 'DEADLOCK');
    assert.equal(failure.message, 'DEADLOCK: attempt 3', 'the error of the last attempt');
  });
});
