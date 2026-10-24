import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { DATABASE, caseTest } from '../../../tests/testcase.mts';
import { Db } from '../dist/database.js';
import { failNextRollback } from '../dist/testing.js';

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

// Requirements: INT-72, DIA-180.
caseTest('transaction-failure/rollback-primary-and-cleanup', DATABASE, async () => {
  await withDatabase('rollback.sqlite', async db => {
    const state = db.pool.state;
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
    const callback = new Error('transaction callback failed');
    await assert.rejects(db.transaction(async () => { throw callback; }, { retry: 0 }), error => {
      assert.equal(error.code, 'ROLLBACK');
      assert.equal(error.cause, callback);
      assert.equal(error.rollback.message, 'DRIVER: sqlite: rollback rejected by the test driver');
      return true;
    });
  });
});

// Requirements: INT-72, DIA-180.
caseTest('transaction-failure/rollback-fault-consumption', DATABASE, async () => {
  await withDatabase('rollback-fault.sqlite', async db => {
    const state = db.pool.state;
    state.statement('CREATE TABLE transaction_failure_rollback_fault (label TEXT NOT NULL)').run();
    failNextRollback(db);
    await db.transaction(async () => {
      state.statement("INSERT INTO transaction_failure_rollback_fault VALUES ('committed')").run();
    }, { retry: 0 });

    const callback = new Error('rollback fault callback failed');
    const failing = async () => {
      state.statement("INSERT INTO transaction_failure_rollback_fault VALUES ('rolled back')").run();
      throw callback;
    };
    await assert.rejects(db.transaction(failing, { retry: 0 }), error => {
      assert.equal(error.code, 'ROLLBACK');
      assert.equal(error.cause, callback);
      assert.equal(error.rollback.code, 'FAULT');
      return true;
    });
    assert.deepEqual(
      state.statement('SELECT label FROM transaction_failure_rollback_fault ORDER BY label').all().map(row => row.label),
      ['committed'],
    );

    await assert.rejects(db.transaction(failing, { retry: 0 }), error => error === callback);
    assert.deepEqual(
      state.statement('SELECT label FROM transaction_failure_rollback_fault ORDER BY label').all().map(row => row.label),
      ['committed'],
    );
  });
});

// Requirements: DIA-181, PLN-17.
caseTest('transaction-failure/savepoint-end-attempts-both', DATABASE, async () => {
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
