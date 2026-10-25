// model_writes coverage: runs create, creates, update, upsert,
// and delete once each with the generated CompositeAccount model. It writes only to composite_account, which has no identity column, and
// deletes all rows it wrote, so the database state is unchanged.
import assert from 'node:assert/strict';
import { CompositeAccount, connect } from '../dist/index.js';
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
  // Requirements: PLN-26.
  async model_write_arithmetic_attributes({ driver, dsn }) {
    const db = await connect(dsn);
    const arithmeticTenant = 1_000_000_000_000 + process.pid;
    const account = () => new CompositeAccount().connect(db);
    try {
      assert.equal(db.driver, driver);
      assert.equal(await account().tenantId(arithmeticTenant).getCount(), 0, 'scratch tenant starts empty');
      await account().setTenantId(arithmeticTenant).setAccountId(1).setName('arithmetic').create();
      const loaded = await account().getByTenantIdAndAccountId(arithmeticTenant, 1);
      assert.ok(loaded, 'created row is readable');
      const events = [];
      const unsubscribe = db.subscribe(event => {
        if (event.kind === 'update' && event.tables.includes('composite_account')) events.push(event);
      });
      try {
        await loaded.plusAccountId(7).update();
        assert.equal((await account().getByTenantIdAndAccountId(arithmeticTenant, 8)).getName(), 'arithmetic', 'plus adds its bound amount');
        assert.ok(events.some(event => event.binds.includes(7)), 'plus amount is bound');
        await loaded.update();
        assert.equal(events.length, 1, 'a write clears the pending arithmetic change');

        const afterPlus = await account().getByTenantIdAndAccountId(arithmeticTenant, 8);
        const amount = afterPlus.getAccountId() + 1;
        await afterPlus.minusAccountId(amount).update();
        assert.equal((await account().getByTenantIdAndAccountId(arithmeticTenant, 0)).getName(), 'arithmetic', 'minus clamps at zero');
        assert.ok(events.some(event => event.binds.includes(amount)), 'minus amount is bound');
      } finally {
        unsubscribe();
      }
    } finally {
      try {
        await account().tenantId(arithmeticTenant).gets().delete();
        assert.equal(await account().tenantId(arithmeticTenant).getCount(), 0, 'scratch row is removed');
      } finally {
        await db.close();
      }
    }
  },
}, 300_000);
