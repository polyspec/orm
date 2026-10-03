// model_writes coverage: 생성된 CompositeAccount model 로 create, creates, update, upsert,
// delete 를 한 번씩 돌린다. identity column 이 없는 composite_account 에만 쓰고 쓴 row 를 모두
// 지우므로 database 상태는 그대로다.
import assert from 'node:assert/strict';
import { CompositeAccount, connect } from '../dist/index.js';
import { errorCode, featureDatabase, runCases, withCleanup } from './coverage_case.mjs';

const tenant = 990002;

await runCases('coverage_model_writes.mjs', {
  async model_write_cycle() {
    const { driver, dsn } = featureDatabase();
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
        assert.equal(await errorCode(account().getByTenantIdAndAccountId(tenant, 1)), 'NO_ROWS', 'deleted row');
        assert.equal(await account().tenantId(tenant).getCount(), 0, 'every row of the tenant deleted');
      }, async () => {
        // 실패한 실행도 이 case 가 쓴 row 를 남기지 않는다.
        await (await account().tenantId(tenant).gets()).delete();
      });
    } finally { await db.close(); }
  },
}, 300_000);
