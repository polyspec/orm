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
  // Requirements: DSL-118, INT-45, PLN-13, PLN-20.
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
}, 300_000);
