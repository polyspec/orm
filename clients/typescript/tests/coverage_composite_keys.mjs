// composite_keys coverage: 두 column primary key 의 row 를 key 로 읽고, 관계로 membership 을
// 읽고, account 를 지우면 ON DELETE CASCADE 가 membership 을 지우는지 확인한다. 쓴 row 는 모두
// 지운다.
import assert from 'node:assert/strict';
import { CompositeAccount, CompositeMembership, Db } from '../dist/index.js';
import { featureDatabase, runCases, withCleanup } from './coverage_case.mjs';

const tenant = 990004;

await runCases('coverage_composite_keys.mjs', {
  async composite_key_rows() {
    const { driver, dsn } = featureDatabase();
    const db = await Db.connect(dsn);
    try {
      assert.equal(db.driver, driver);
      const account = () => new CompositeAccount().connect(db);
      const membership = () => new CompositeMembership().connect(db);
      assert.equal(await account().tenantId(tenant).getCount(), 0, `no composite_account row of tenant ${tenant} before the case`);
      assert.equal(await membership().tenantId(tenant).getCount(), 0, `no composite_membership row of tenant ${tenant} before the case`);
      await withCleanup(async () => {
        await account().setTenantId(tenant).setAccountId(1).setName('a').create();
        await account().setTenantId(tenant).setAccountId(2).setName('b').create();
        await membership().setTenantId(tenant).setAccountId(2).setRole('owner').create();
        assert.equal((await account().getByTenantIdAndAccountId(tenant, 2)).getName(), 'b', 'row read by both key components');
        // match<L>With<R> 는 column 한 쌍을 잇는다. tenant_id 로 잇고 account_id 를 child 조건으로 둔다.
        const loaded = await account()
          .relations(new CompositeMembership().matchTenantIdWithTenantId().accountId(2).aliasMemberships())
          .getByTenantIdAndAccountId(tenant, 2);
        const roles = loaded.getMemberships().values().map(m => [m.getTenantId(), m.getAccountId(), m.getRole()]);
        assert.deepEqual(roles, [[tenant, 2, 'owner']], 'memberships of the account');
        await (await account().getByTenantIdAndAccountId(tenant, 2)).delete();
        assert.equal(await membership().tenantId(tenant).getCount(), 0, 'ON DELETE CASCADE removed the membership');
        await (await account().getByTenantIdAndAccountId(tenant, 1)).delete();
        assert.equal(await account().tenantId(tenant).getCount(), 0, 'no account of the tenant remains');
      }, async () => {
        // 실패한 실행도 이 case 가 쓴 row 를 남기지 않는다.
        await (await membership().tenantId(tenant).gets()).delete();
        await (await account().tenantId(tenant).gets()).delete();
      });
    } finally { await db.close(); }
  },
}, 300_000);
