// transactions coverage: a callback error or an aborted statement rolls back the transaction and is passed to the caller,
// and a nested transaction rolls back only its inner writes with a savepoint. The written rows
// are only in composite_account, and the case deletes all of them when it ends.
import assert from 'node:assert/strict';
import { CompositeAccount, OrmError, codes, connect } from '../dist/index.js';
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
  // Requirements: DSL-118, INT-45, INT-67, PLN-13, PLN-16, PLN-20, PLN-44.
  async transaction_rollback(item) {
    await withTenant(item, async db => {
      await assert.rejects(
        () => new CompositeAccount().getCount(),
        error => error instanceof OrmError && error.code === codes.CONFIG,
        'an unconnected model outside a transaction returns CONFIG',
      );
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

  // Requirements: DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-47, INT-48, PLN-17, PLN-21, PLN-24, PLN-44.
  async transaction_savepoint(item) {
    await withTenant(item, async db => {
      const boom = new Error('inner transaction failed');
      let inner = null;
      for (const isolation of ['read_uncommitted', 'read_committed', 'repeatable_read', 'serializable']) {
        await db.transaction(async () => {}, { isolation, retry: 0 });
      }
      await db.transaction(async () => {
        await new CompositeAccount().setTenantId(tenant).setAccountId(2).setName('outer').create();
        for (const lock of ['forUpdate', 'forShare', 'forUpdateNoWait', 'forShareNoWait']) {
          const row = await new CompositeAccount().connect(db).tenantId(tenant).andAccountId(2)[lock]().get();
          assert.notEqual(row, null, `${lock} works inside a transaction`);
        }
        for (const options of [{ isolation: 'serializable' }, { readOnly: true }, { timeoutMs: 1 }]) {
          let called = false;
          await assert.rejects(() => db.transaction(() => { called = true; }, options), error => error instanceof OrmError && error.code === codes.CONFIG, 'a nested transaction rejects every option except retry');
          assert.equal(called, false, 'an invalid nested option does not run its callback');
        }
        let innerCalls = 0;
        try {
          await db.transaction(async () => {
            innerCalls++;
            await new CompositeAccount().setTenantId(tenant).setAccountId(3).setName('inner').create();
            throw boom;
          }, { retry: 3 });
        } catch (error) { inner = error; }
        assert.equal(innerCalls, 1, 'nested retry is accepted and ignored');
      });
      assert.equal(inner, boom, 'the nested transaction error reaches the outer callback');
      assert.equal(await exists(db, 2), true, 'the outer row is committed');
      assert.equal(await exists(db, 3), false, 'the inner row is rolled back to the savepoint');
      for (const lock of ['forUpdate', 'forShare', 'forUpdateNoWait', 'forShareNoWait']) {
        await assert.rejects(
          () => new CompositeAccount().connect(db).tenantId(tenant).andAccountId(2)[lock]().get(),
          error => error instanceof OrmError && error.code === codes.CONFIG,
          `${lock} outside a transaction returns CONFIG`,
        );
      }
      await (await new CompositeAccount().connect(db).getByTenantIdAndAccountId(tenant, 2)).delete();
      assert.equal(await exists(db, 2), false, 'the outer row is deleted');

      await db.transaction(async () => {
        const concurrent = await Promise.allSettled([
          new CompositeAccount().getCount(),
          new CompositeAccount().getCount(),
        ]);
        assert.ok(concurrent.some(result => result.status === 'rejected' && result.reason instanceof OrmError && result.reason.code === codes.CONFIG), 'overlapping task use of one transaction returns CONFIG');
      }, { retry: 0 });

      let readOnlyError = null;
      try {
        await db.transaction(async () => {
          await new CompositeAccount().setTenantId(tenant).setAccountId(4).setName('read only').create();
        }, { readOnly: true, retry: 0 });
      } catch (error) { readOnlyError = error; }
      assert.ok(readOnlyError instanceof OrmError && readOnlyError.code === codes.READ_ONLY, `read-only write error: ${readOnlyError}`);
      assert.equal(await exists(db, 4), false, 'read-only transaction wrote a row');

      let timeoutError = null;
      let timeoutCalls = 0;
      try { await db.transaction(async () => { timeoutCalls++; }, { timeoutMs: 500, retry: 0 }); }
      catch (error) { timeoutError = error; }
      if (item.driver === 'postgres') {
        assert.equal(timeoutError, null, 'PostgreSQL supports transaction timeoutMs');
        assert.equal(timeoutCalls, 1, 'PostgreSQL timeout callback ran');
      } else {
        assert.ok(timeoutError instanceof OrmError && timeoutError.code === codes.CAPABILITY_UNSUPPORTED, `${item.driver} timeoutMs: ${timeoutError}`);
        assert.equal(timeoutCalls, 0, 'unsupported timeout fails before the callback');
      }

      if (item.driver === 'postgres') {
        await new CompositeAccount().connect(db).setTenantId(tenant).setAccountId(6).setName('before timeout').create();
        const holder = await connect(item.dsn);
        let announceLocked;
        const locked = new Promise(resolve => { announceLocked = resolve; });
        let releaseHolder;
        const released = new Promise(resolve => { releaseHolder = resolve; });
        try {
          const heldTransaction = holder.transaction(async () => {
            await new CompositeAccount().connect(holder).tenantId(tenant).forUpdate().get();
            announceLocked();
            await released;
          }, { retry: 0 });
          await locked;
          let lockedTimeoutError = null;
          try {
            await db.transaction(async () => {
              await new CompositeAccount().connect(db).tenantId(tenant).setName('timed out').update();
            }, { timeoutMs: 250, retry: 0 });
          } catch (error) { lockedTimeoutError = error; }
          assert.ok(lockedTimeoutError instanceof OrmError && lockedTimeoutError.code === codes.CANCELED, `locked statement timeout: ${lockedTimeoutError}`);
          releaseHolder();
          await heldTransaction;
          assert.equal((await new CompositeAccount().connect(db).getByTenantIdAndAccountId(tenant, 6)).getName(), 'before timeout', 'timed out update rolled back');
          await (await new CompositeAccount().connect(db).getByTenantIdAndAccountId(tenant, 6)).delete();
        } finally {
          releaseHolder();
          await holder.close();
        }
      }

      let attempts = 0;
      await db.transaction(async () => {
        attempts++;
        await new CompositeAccount().setTenantId(tenant).setAccountId(5).setName(`attempt-${attempts}`).create();
        if (attempts < 3) throw new OrmError(codes.DEADLOCK, 'coverage retry');
      }, { isolation: 'read_committed', retry: 3 });
      assert.equal(attempts, 3, 'retry reruns the complete callback');
      assert.equal((await new CompositeAccount().connect(db).getByTenantIdAndAccountId(tenant, 5)).getName(), 'attempt-3', 'the final callback attempt committed');
      await (await new CompositeAccount().connect(db).getByTenantIdAndAccountId(tenant, 5)).delete();

      let defaultAttempts = 0;
      await db.transaction(async () => {
        defaultAttempts++;
        if (defaultAttempts < 3) throw new OrmError(codes.DEADLOCK, 'default coverage retry');
      });
      assert.equal(defaultAttempts, 3, 'default retry count is three');

      attempts = 0;
      let retryError = null;
      try {
        await db.transaction(async () => {
          attempts++;
          throw new OrmError(codes.DEADLOCK, 'coverage retry disabled');
        }, { retry: 0 });
      } catch (error) { retryError = error; }
      assert.ok(retryError instanceof OrmError && retryError.code === codes.DEADLOCK, `retry=0 error: ${retryError}`);
      assert.equal(attempts, 1, 'retry=0 invokes the callback once');
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
