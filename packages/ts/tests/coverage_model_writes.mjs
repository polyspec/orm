// model_writes coverage uses CompositeAccount for CRUD and seeded Author.read_count for arithmetic.
// The arithmetic case rolls back its updates to preserve the seeded row and identity sequence.
import assert from 'node:assert/strict';
import { Account, Author, CompositeAccount, connect } from '../dist/index.js';
import { errorCode, runCases, withCleanup } from './coverage_case.mjs';

const tenant = 990002;

await runCases('coverage_model_writes.mjs', {
  // Requirements: DSL-104, INT-35, PRT-41.
  async create_parts({ driver, dsn }) {
    const db = await connect(dsn);
    const createTenant = tenant + 1;
    const account = () => new CompositeAccount().connect(db);
    try {
      assert.equal(db.driver, driver);
      assert.equal(await account().tenantId(createTenant).getCount(), 0, 'tenant starts empty');
      const events = [];
      const unsubscribe = db.subscribe(event => { events.push(event); });
      try {
        const refused = [new CompositeAccount().setTenantId(createTenant).setAccountId(1).setName('refused')];
        assert.equal(await errorCode(account().creates(refused, 0)), 'CONFIG', 'batch zero is refused');
        assert.equal(events.length, 0, 'invalid batch sends no statements');
        const limit = driver === 'sqlite' ? 999 : 65535;
        const oversized = Array.from({ length: Math.floor(limit / 3) + 1 }, () =>
          new CompositeAccount().setTenantId(createTenant).setAccountId(8).setName('oversized'));
        assert.equal(await errorCode(account().creates(oversized, oversized.length)), 'BATCH_TOO_LARGE', 'over-limit batch is refused');
        assert.equal(events.length, 0, 'over-limit batch sends no statements');

        const labels = ['ordered-5', 'ordered-4', 'ordered-3', 'ordered-2', 'ordered-1'];
        const rows = labels.map((name, i) => new CompositeAccount().setTenantId(createTenant).setAccountId(i + 1).setName(name));
        assert.equal(await account().creates(rows, 2), 5, 'creates inserts all rows');
        const inserts = events.filter(event => event.kind === 'insert');
        assert.deepEqual(inserts.map(event => event.binds.length / 3), [2, 2, 1], 'INSERT batches are 2, 2, 1');
        const stored = await account().tenantId(createTenant).orderByAccountIdAsc().gets();
        assert.deepEqual([...stored].map(row => row.getName()), labels, 'stored rows preserve input order');

        await (await account().tenantId(createTenant).gets()).delete();
        events.length = 0;
        await account().setTenantId(createTenant).setAccountId(99).setName('existing').create();
        events.length = 0;
        const failing = [10, 11, 12, 13, 99].map(id => new CompositeAccount()
          .setTenantId(createTenant).setAccountId(id).setName(`rollback-${id}`));
        assert.equal(await errorCode(account().creates(failing, 2)), 'DUPLICATE_KEY', 'third batch conflicts with sentinel');
        const failedInserts = events.filter(event => event.kind === 'insert');
        assert.deepEqual(failedInserts.map(event => event.binds.length / 3), [2, 2, 1], 'failure is in third batch');
        assert.equal(await account().tenantId(createTenant).getCount(), 1, 'failed call rolls back earlier batches');
        assert.equal((await account().getByTenantIdAndAccountId(createTenant, 99)).getName(), 'existing');
      } finally { unsubscribe(); }
    } finally {
      try {
        await withCleanup(async () => {
            await (await account().tenantId(createTenant).gets()).delete();
          assert.equal(await account().tenantId(createTenant).getCount(), 0, 'case leaves no rows');
        }, async () => { await (await account().tenantId(createTenant).gets()).delete(); });
      } finally {
        await db.close();
      }
    }
  },
  // Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-110.
  async model_write_cycle({ driver, dsn }) {
    const db = await connect(dsn);
    try {
      assert.equal(db.driver, driver);
      const account = () => new CompositeAccount().connect(db);
      assert.equal(await account().tenantId(tenant).getCount(), 0, `no composite_account row of tenant ${tenant} before the case`);
      await withCleanup(async () => {
        const created = await account().setTenantId(tenant).setAccountId(1).setName('created').create();
        assert.equal(created.getName(), 'created');
        const inserted = await account().creates([2, 3, 4].map(id =>
          new CompositeAccount().setTenantId(tenant).setAccountId(id).setName(`many-${id}`)), 3);
        assert.equal(inserted, 3, 'rows inserted by creates');
        await (await account().getByTenantIdAndAccountId(tenant, 1)).setName('updated').update();
        assert.equal((await account().getByTenantIdAndAccountId(tenant, 1)).getName(), 'updated', 'updated name');
        await account().setTenantId(tenant).setAccountId(1).setName('ignored')
          .duplication(new CompositeAccount().setName('upserted')).create();
        assert.equal((await account().getByTenantIdAndAccountId(tenant, 1)).getName(), 'upserted', 'duplication assignment');
        assert.equal(await account().tenantId(tenant).getCount(), 4, 'rows of the tenant');
        const names = (await account().tenantId(tenant).orderByAccountIdAsc().gets()).values().map(a => a.getName());
        assert.deepEqual(names, ['upserted', 'many-2', 'many-3', 'many-4'], 'names of the tenant rows');
        await (await account().tenantId(tenant).gets()).delete();
        assert.equal(await account().getByTenantIdAndAccountId(tenant, 1), null, 'deleted row');
        assert.equal(await account().tenantId(tenant).getCount(), 0, 'every row of the tenant deleted');
      }, async () => {
        // Even a failed run leaves no rows written by this case.
        await (await account().tenantId(tenant).gets()).delete();
      });
    } finally { await db.close(); }
  },
  // Requirements: DSL-109.
  async save_key_dispatch({ driver, dsn }) {
    const db = await connect(dsn);
    const writes = [];
    const sentinel = new Error('DSL-109 request hook stopped the write');
    const hooked = db.withRequestHook(request => {
      if (request.kind === 'insert' || request.kind === 'update') {
        writes.push(request.kind);
        throw sentinel;
      }
      return request;
    });
    const rejectedByHook = async promise => assert.rejects(promise, error => error === sentinel);
    try {
      assert.equal(db.driver, driver);
      await rejectedByHook(new Account().connect(hooked).setName('missing').save());
      assert.deepEqual(writes, ['insert'], 'missing key dispatches INSERT before execution');

      writes.length = 0;
      await rejectedByHook(new Account().connect(hooked).setSeq(0).setName('zero').save());
      assert.deepEqual(writes, ['update'], 'explicit zero dispatches UPDATE before execution');

      writes.length = 0;
      const loaded = await new Author().connect(hooked).removeAllColumns().addColumnSeq().addColumnReadCount().getBySeq(1);
      assert.ok(loaded, 'seeded author row loads through the hooked handle');
      await rejectedByHook(loaded.setReadCount(loaded.getReadCount()).save());
      assert.deepEqual(writes, ['update'], 'loaded original key dispatches UPDATE before execution');
    } finally {
      await db.close();
    }
  },
  // Requirements: PLN-26.
  async model_write_arithmetic_attributes({ driver, dsn }) {
    const db = await connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
    const author = () => new Author().connect(db);
    let unsubscribe = null;
    try {
      assert.equal(db.driver, driver);
      const before = await author().addAllColumns().getBySeq(1);
      assert.ok(before, 'seed author 1 exists');
      const beforeReadCount = before.getReadCount();
      const beforeUpdatedTs = before.getUpdatedTs();
      assert.equal(beforeReadCount, 1, 'seed author 1 read_count');
      const boom = new Error('PLN-26 rollback sentinel');
      const events = [];
      let caught = null;
      try {
        await db.transaction(async () => {
          let loaded = await author().addAllColumns().getBySeq(1);
          assert.ok(loaded, 'seed author 1 is readable in the transaction');
          await loaded.setReadCount(1).update();
          unsubscribe = db.subscribe(event => {
            if (event.kind === 'update' && event.tables.includes('author')) events.push(event);
          });
          loaded = await author().addAllColumns().getBySeq(1);
          await loaded.plusReadCount(7).update();
          assert.equal((await author().addAllColumns().getBySeq(1)).getReadCount(), 8, 'plus updates the non-key column');
          assert.ok(events.some(event => event.binds.includes(7)), 'plus amount is bound');
          await loaded.update();
          assert.equal(events.length, 1, 'a write clears the pending arithmetic change');
          const current = await author().addAllColumns().getBySeq(1);
          await current.minusReadCount(9).update();
          const afterMinus = await author().addAllColumns().getBySeq(1);
          assert.equal(afterMinus.getReadCount(), 0, 'minus clamps at zero');
          assert.ok(events.some(event => event.binds.includes(9)), 'minus amount is bound');
          throw boom;
        }, { retry: 0 });
      } catch (error) {
        caught = error;
      }
      assert.strictEqual(caught, boom, 'transaction returns the rollback sentinel');
      const after = await author().addAllColumns().getBySeq(1);
      assert.equal(after.getReadCount(), beforeReadCount, 'rollback restores read_count');
      assert.deepEqual(after.getUpdatedTs(), beforeUpdatedTs, 'rollback restores updated_ts');
    } finally {
      if (unsubscribe) unsubscribe();
      await db.close();
    }
  },
}, 300_000);
