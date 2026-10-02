// transactions coverage: callback 의 오류가 transaction 을 rollback 하고 호출자에게 그대로
// 전달되는지, 중첩 transaction 이 savepoint 로 안쪽 write 만 되돌리는지 확인한다. 쓴 row 는
// composite_account 에만 있고 case 가 끝날 때 모두 지운다.
import assert from 'node:assert/strict';
import { CompositeAccount, Db } from '../dist/index.js';
import { featureDatabase, runCases, withCleanup } from './coverage_case.mjs';

const tenant = 990003;

/** Opens the selected database, runs the case and removes every row of the tenant afterwards. */
async function withTenant(body) {
  const { driver, dsn } = featureDatabase();
  const db = await Db.connect(dsn);
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
  async transaction_rollback() {
    await withTenant(async db => {
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
    });
  },

  async transaction_savepoint() {
    await withTenant(async db => {
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
