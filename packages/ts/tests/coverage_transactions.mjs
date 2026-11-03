// The transaction behaviours of the host cancellation handle: an aborted statement rolls the transaction back, and an abandoned
// query is cancelled. The written rows are only in composite_account, and the case deletes all of them when it ends.
import assert from 'node:assert/strict';
import { CompositeAccount, OrmError, connect } from '../dist/index.js';
import { runCases, withCleanup } from './coverage_case.mjs';

const tenant = 990003;

/** Opens the selected database, runs the case and removes every row of the tenant afterwards. */
async function withTenant({ driver, dsn }, body) {
  const db = await connect(dsn);
  try {
    assert.equal(db.driver, driver);
    assert.equal(await new CompositeAccount().connect(db).tenantId(tenant).getCount(), 0, `no composite_account row of tenant ${tenant} before the case`);
    await withCleanup(() => body(db), async () => {
      await (await new CompositeAccount().connect(db).tenantId(tenant).gets()).delete();
    });
  } finally { await db.close(); }
}

const exists = async (db, account) => await new CompositeAccount().connect(db).tenantId(tenant).andAccountId(account).getCount() === 1;

await runCases('coverage_transactions.mjs', {
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
    const { driver } = item;
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

      releaseHolder();
      assert.equal(await holder, rollback, `${driver}: releasing the holder rolls its transaction back`);
      assert.equal((await new CompositeAccount().connect(db).getByTenantIdAndAccountId(tenant, 6)).getName(), 'original', `${driver}: cancellation and rollback preserve the stored row`);
      assert.equal(await exists(db, 6), true, `${driver}: the connection handle remains usable`);
    });
  },
}, 300_000);
