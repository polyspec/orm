// transactions coverage: a callback error or an aborted statement rolls back the transaction and is passed to the caller,
// and a nested transaction rolls back only its inner writes with a savepoint. The written rows
// are only in composite_account, and the case deletes all of them when it ends.
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
  // Requirements: DSL-118, INT-45, INT-67, PLN-13, PLN-20.
  async transaction_rollback(item) {
    await withTenant(item, async db => {
      const boom = new Error('rollback requested by the callback');
      let caught = null;
      try {
        await db.transaction(async () => {
          await new CompositeAccount().setTenantId(tenant).setAccountId(1).setName('rolled').create();
          throw boom;
        });
      } catch (error) { caught = error; }
      assert.equal(caught, boom, 'the callback error reaches the caller');
      assert.equal(await exists(db, 1), false, 'the rolled back row does not exist');

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

  // Requirements: DSL-119, INT-45, INT-46, PLN-17.
  async transaction_savepoint(item) {
    await withTenant(item, async db => {
      const boom = new Error('inner transaction failed');
      let inner = null;
      await db.transaction(async () => {
        await new CompositeAccount().setTenantId(tenant).setAccountId(2).setName('outer').create();
        try {
          await db.transaction(async () => {
            await new CompositeAccount().setTenantId(tenant).setAccountId(3).setName('inner').create();
            throw boom;
          });
        } catch (error) { inner = error; }
      });
      assert.equal(inner, boom, 'the nested transaction error reaches the outer callback');
      assert.equal(await exists(db, 2), true, 'the outer row is committed');
      assert.equal(await exists(db, 3), false, 'the inner row is rolled back to the savepoint');
      await (await new CompositeAccount().connect(db).getByTenantIdAndAccountId(tenant, 2)).delete();
      assert.equal(await exists(db, 2), false, 'the outer row is deleted');
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
