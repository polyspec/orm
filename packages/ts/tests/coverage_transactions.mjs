// The transaction behaviours of the host cancellation handle: an aborted statement rolls the transaction back, and an abandoned
// query is cancelled. The written rows are only in composite_account, and the case deletes all of them when it ends.
import assert from 'node:assert/strict';
import { CompositeAccount, OrmError, connect } from '../dist/index.js';
import { after } from 'node:test';
import { installBench } from './bench-set.mjs';
import { createCaseDatabase } from './case-database.mjs';
import { runCasesOn, withCleanup } from './coverage_case.mjs';

const tenant = 990003;

/** Opens the selected database, runs the case and removes every row of the tenant afterwards. */
async function withTenant({ driver, dsn }, body) {
  const db = await connect(dsn);
  try {
    // MariaDB is a server of the MySQL dialect, reached with the mysql driver (DIA-200).
    assert.equal(db.driver, driver === 'mariadb' ? 'mysql' : driver);
    assert.equal(await new CompositeAccount().connect(db).tenantId(tenant).getCount(), 0, `no composite_account row of tenant ${tenant} before the case`);
    await withCleanup(() => body(db), async () => {
      await (await new CompositeAccount().connect(db).tenantId(tenant).gets()).delete();
    });
  } finally { await db.close(); }
}

const exists = async (db, account) => await new CompositeAccount().connect(db).tenantId(tenant).andAccountId(account).getCount() === 1;

/** The cases, on the bench databases of SQLite and PostgreSQL here and on a case database of MySQL and of MariaDB in
 * coverage_transactions-mysql.test.mjs and coverage_transactions-mariadb.test.mjs (runOnCaseDatabase). */
export const cases = {
  // Requirements: INT-67.
  async transaction_rollback(item) {
    await withTenant(item, async db => {
      const controller = new AbortController();
      const signalled = db.withSignal(controller.signal);
      let cancellation = null;
      try {
        await signalled.transaction(async () => {
          await new CompositeAccount().connect(signalled).setTenantId(tenant).setAccountId(4).setName('cancelled').create();
          controller.abort();
          await new CompositeAccount().connect(signalled).setTenantId(tenant).setAccountId(5).setName('not written').create();
        });
      } catch (error) { cancellation = error; }
      assert.ok(cancellation instanceof OrmError && cancellation.code === 'CANCELED', 'the aborted statement ends the transaction');
      assert.equal(await exists(db, 4), false, 'aborting a transaction rolls back its earlier write');
      assert.equal(await exists(db, 5), false, 'the aborted statement did not write its row');
    });
  },

  // Requirements: CFG-9.
  async handle_abandoned_query(item) {
    const { driver, dsn } = item;
    await withTenant(item, async db => {
      await new CompositeAccount().connect(db).setTenantId(tenant).setAccountId(6).setName('original').create();

      let announceHeld;
      const rowHeld = new Promise(resolve => { announceHeld = resolve; });
      let releaseHolder;
      const holderReleased = new Promise(resolve => { releaseHolder = resolve; });
      const rollback = new Error('release the row lock');
      const holder = db.transaction(async () => {
        await new CompositeAccount().connect(db).setTenantId(tenant).setAccountId(6).setName('held').update();
        announceHeld();
        await holderReleased;
        throw rollback;
      }).catch(error => error);
      await rowHeld;

      const controller = new AbortController();
      const signalled = db.withSignal(controller.signal);
      let statement;
      if (driver === 'sqlite') {
        // SQLite executes synchronously, so the signal applies to the next statement.
        controller.abort();
        statement = new CompositeAccount().connect(signalled).setTenantId(tenant).setAccountId(6).setName('cancelled').update();
      } else {
        statement = new CompositeAccount().connect(signalled).setTenantId(tenant).setAccountId(6).setName('cancelled').update();
        setTimeout(() => controller.abort(), 100);
      }
      let cancellation = null;
      try { await statement; } catch (error) { cancellation = error; }
      assert.ok(cancellation instanceof OrmError && cancellation.code === 'CANCELED', `${driver}: the abandoned statement is cancelled`);

      // A statement that utils().run sends on the signalled handle is bound to the same signal (INT-150).
      const frameController = new AbortController();
      const frameHandle = db.withSignal(frameController.signal);
      const frameSql = `UPDATE composite_account SET name = 'by frame' WHERE tenant_id = ${tenant} AND account_id = 6`;
      if (driver === 'sqlite') frameController.abort();
      else setTimeout(() => frameController.abort(), 100);
      let frameCancellation = null;
      try { await frameHandle.utils().run(frame => frame.run('update', ['composite_account'], frameSql)); } catch (error) { frameCancellation = error; }
      assert.ok(frameCancellation instanceof OrmError && frameCancellation.code === 'CANCELED', `${driver}: the abandoned statement of utils().run is cancelled: ${String(frameCancellation)}`);

      releaseHolder();
      assert.equal(await holder, rollback, `${driver}: releasing the holder rolls its transaction back`);
      assert.equal((await new CompositeAccount().connect(db).getByTenantIdAndAccountId(tenant, 6)).getName(), 'original', `${driver}: cancellation and rollback preserve the stored row`);
      assert.equal(await exists(db, 6), true, `${driver}: the connection handle remains usable`);

      // On a pool of one connection that another transaction takes, the transaction of utils().run waits for the connection; the abort ends that wait.
      const single = await connect(dsn, { poolSize: 1 });
      try {
        let freeSingle;
        const singleFree = new Promise(resolve => { freeSingle = resolve; });
        let announceTaken;
        const taken = new Promise(resolve => { announceTaken = resolve; });
        const taker = single.utils().run(async () => { announceTaken(); await singleFree; });
        await taken;
        const waitController = new AbortController();
        setTimeout(() => waitController.abort(), 100);
        let waitCancellation = null;
        try { await single.withSignal(waitController.signal).utils().run(frame => frame.run('select', [], 'SELECT 1')); } catch (error) { waitCancellation = error; }
        assert.ok(waitCancellation instanceof OrmError && waitCancellation.code === 'CANCELED', `${driver}: the wait for the connection of a transaction is cancelled: ${String(waitCancellation)}`);
        freeSingle();
        await taker;
        assert.equal((await single.utils().run(frame => frame.run('select', [], 'SELECT 1'))).rows.length, 1, `${driver}: the pool of one connection serves the next transaction`);
      } finally { await single.close(); }
    });
  },
};

/**
 * Runs the cases on a case database of dialect with the bench set installed, which is dropped when the file ends: this file
 * runs them on SQLite and PostgreSQL, and the entries coverage_transactions-mysql.test.mjs and
 * coverage_transactions-mariadb.test.mjs on the two servers of the MySQL dialect (DIA-200).
 */
export async function runOnCaseDatabase(dialect, file = `coverage_transactions-${dialect}.test.mjs`) {
  const database = await createCaseDatabase(dialect, text => console.log(text));
  after(() => database.drop(text => console.log(text)));
  const db = await connect(database.dsn);
  try { await installBench(db); } finally { await db.close(); }
  await runCasesOn(dialect, file, cases, 300_000, database.dsn);
}

if (import.meta.main) {
  for (const dialect of ['sqlite', 'postgres']) await runOnCaseDatabase(dialect, 'coverage_transactions.mjs');
}
