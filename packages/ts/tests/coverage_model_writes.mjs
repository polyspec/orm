// model_writes coverage: runs create, creates, update, upsert,
// and delete once each with the generated CompositeAccount model. It writes only to composite_account, which has no identity column, and
// deletes all rows it wrote, so the database state is unchanged.
import assert from 'node:assert/strict';
import { CompositeAccount, connect } from '../dist/index.js';
import { runCases, withCleanup } from './coverage_case.mjs';

const tenant = 990002;

await runCases('coverage_model_writes.mjs', {
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
          new CompositeAccount().setTenantId(tenant).setAccountId(id).setName(`many-${id}`)));
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
}, 300_000);
