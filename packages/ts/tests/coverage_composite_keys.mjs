// composite_keys coverage: reads a row of a two-column primary key by its key, and the two parts of a foreign key
// (tenant_id, account_id) form a relation that reads the membership, and deleting an account
// is checked to cascade to the membership with ON DELETE CASCADE. All written rows are deleted.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CompositeAccount, CompositeMembership, connect } from '../dist/index.js';
import { runCases, withCleanup } from './coverage_case.mjs';

// Account 2 must also exist in another tenant, so that a relation linked by the account_id component alone is exposed.
const tenant = 990004;
const otherTenant = 990006;
const collisionFixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/composite_key_collision.json', import.meta.url), 'utf8'));
const collisionRows = collisionFixture.cases.find(item => item.id === 'composite_key_rows').expected;
const collisionTenant = collisionRows[0].tenant_id;
const collisionOtherTenant = collisionRows[1].tenant_id;

await runCases('coverage_composite_keys.mjs', {
  // Requirements: INT-87, PRT-12.
  async composite_key_rows({ driver, dsn }) {
    const db = await connect(dsn);
    try {
      assert.equal(db.driver, driver);
      const account = () => new CompositeAccount().connect(db);
      const membership = () => new CompositeMembership().connect(db);
      for (const t of [tenant, otherTenant, collisionTenant, collisionOtherTenant]) {
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
        for (const row of collisionRows) {
          await account().setTenantId(row.tenant_id).setAccountId(row.account_id).setName(row.name).create();
          await membership().setTenantId(row.tenant_id).setAccountId(row.account_id).setRole(row.role).create();
        }
        assert.equal((await account().getByTenantIdAndAccountId(tenant, 2)).getName(), 'b', 'row read by both key components');
        // A relation links the two parts of a foreign key in key order. When a child has its own link, after reading the parent row
        // it is read separately. The two paths give the same result.
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
        assert.equal(
          `${collisionRows[0].tenant_id}${collisionRows[0].account_id}`,
          `${collisionRows[1].tenant_id}${collisionRows[1].account_id}`,
          'the collision fixture has equal concatenated composite keys',
        );
        for (const [path, child] of [
          ['same statement', new CompositeMembership()],
          ['own connection', new CompositeMembership().connect(db)],
        ]) {
          const loaded = await account().tupleTenantIdWithAccountId([
            [collisionRows[0].tenant_id, collisionRows[0].account_id],
            [collisionRows[1].tenant_id, collisionRows[1].account_id],
          ]).orderByTenantIdAsc().orderByAccountIdAsc().relations(child.matchTenantIdWithTenantId().matchAccountIdWithAccountId().aliasMemberships()).gets();
          const got = [];
          for (const a of loaded.values()) {
            for (const m of a.getMemberships().values()) got.push(`${a.getTenantId()}/${a.getAccountId()}:${m.getTenantId()}/${m.getAccountId()}/${m.getRole()}`);
          }
          assert.deepEqual(got, collisionRows.map(row =>
            `${row.tenant_id}/${row.account_id}:${row.tenant_id}/${row.account_id}/${row.role}`,
          ), `${path}: colliding concatenated composite keys keep relations separate`);
        }
        await (await account().getByTenantIdAndAccountId(tenant, 2)).delete();
        assert.equal(await membership().tenantId(tenant).getCount(), 1, 'ON DELETE CASCADE removed the membership of account 2');
        for (const t of [tenant, otherTenant, collisionTenant, collisionOtherTenant]) {
          await (await account().tenantId(t).gets()).delete();
          assert.equal(await account().tenantId(t).getCount(), 0, `no account of tenant ${t} remains`);
          assert.equal(await membership().tenantId(t).getCount(), 0, `no membership of tenant ${t} remains`);
        }
      }, async () => {
        // Even a failed run leaves no rows written by this case.
        for (const t of [tenant, otherTenant]) {
          await (await membership().tenantId(t).gets()).delete();
          await (await account().tenantId(t).gets()).delete();
        }
      });
    } finally { await db.close(); }
  },
}, 300_000);
