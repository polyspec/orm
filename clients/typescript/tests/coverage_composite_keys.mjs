// composite_keys coverage: 두 column primary key 의 row 를 key 로 읽고, foreign key 의 두 성분
// (tenant_id, account_id)으로 잇는 relation 으로 membership 을 읽고, account 를 지우면
// ON DELETE CASCADE 가 membership 을 지우는지 확인한다. 쓴 row 는 모두 지운다.
import assert from 'node:assert/strict';
import { CompositeAccount, CompositeMembership, Db } from '../dist/index.js';
import { featureDatabase, runCases, withCleanup } from './coverage_case.mjs';

// 다른 tenant 에도 account 2 가 있어야 account_id 한 성분만으로 잇는 relation 이 드러난다.
const tenant = 990004;
const otherTenant = 990006;

await runCases('coverage_composite_keys.mjs', {
  async composite_key_rows() {
    const { driver, dsn } = featureDatabase();
    const db = await Db.connect(dsn);
    try {
      assert.equal(db.driver, driver);
      const account = () => new CompositeAccount().connect(db);
      const membership = () => new CompositeMembership().connect(db);
      for (const t of [tenant, otherTenant]) {
        assert.equal(await account().tenantId(t).getCount(), 0, `no composite_account row of tenant ${t} before the case`);
        assert.equal(await membership().tenantId(t).getCount(), 0, `no composite_membership row of tenant ${t} before the case`);
      }
      await withCleanup(async () => {
        await account().setTenantId(tenant).setAccountId(1).setName('a').create();
        await account().setTenantId(tenant).setAccountId(2).setName('b').create();
        await account().setTenantId(otherTenant).setAccountId(2).setName('c').create();
        await membership().setTenantId(tenant).setAccountId(1).setRole('member').create();
        await membership().setTenantId(tenant).setAccountId(2).setRole('owner').create();
        await membership().setTenantId(otherTenant).setAccountId(2).setRole('guest').create();
        assert.equal((await account().getByTenantIdAndAccountId(tenant, 2)).getName(), 'b', 'row read by both key components');
        // relation 은 foreign key 의 두 성분을 key 순서대로 잇는다. 자식이 자기 연결을 가지면 부모 row 를 읽은 뒤
        // 따로 읽는다. 두 경로가 같은 결과를 낸다.
        const same = await account().tenantId(tenant)
          .relations(new CompositeMembership().matchTenantIdWithTenantId().matchAccountIdWithAccountId().aliasMemberships())
          .gets();
        const own = await account().tenantId(tenant)
          .relations(new CompositeMembership().connect(db).matchTenantIdWithTenantId().matchAccountIdWithAccountId().aliasMemberships())
          .gets();
        for (const [path, loaded] of [['same statement', same], ['own connection', own]]) {
          const got = [];
          for (const a of loaded.values()) {
            for (const m of a.getMemberships().values()) got.push(`${a.getTenantId()}/${a.getAccountId()}:${m.getTenantId()}/${m.getAccountId()}/${m.getRole()}`);
          }
          assert.deepEqual(got, [`${tenant}/1:${tenant}/1/member`, `${tenant}/2:${tenant}/2/owner`], `${path}: memberships of tenant ${tenant} accounts`);
        }
        await (await account().getByTenantIdAndAccountId(tenant, 2)).delete();
        assert.equal(await membership().tenantId(tenant).getCount(), 1, 'ON DELETE CASCADE removed the membership of account 2');
        for (const t of [tenant, otherTenant]) {
          await (await account().tenantId(t).gets()).delete();
          assert.equal(await account().tenantId(t).getCount(), 0, `no account of tenant ${t} remains`);
          assert.equal(await membership().tenantId(t).getCount(), 0, `no membership of tenant ${t} remains`);
        }
      }, async () => {
        // 실패한 실행도 이 case 가 쓴 row 를 남기지 않는다.
        for (const t of [tenant, otherTenant]) {
          await (await membership().tenantId(t).gets()).delete();
          await (await account().tenantId(t).gets()).delete();
        }
      });
    } finally { await db.close(); }
  },
}, 300_000);
