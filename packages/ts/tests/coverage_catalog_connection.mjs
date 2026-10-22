// catalog_connection coverage (Requirements: SCH-5, SCH-6a): runs the two shared cases against the bench database that the
// feature check selected (ORM_FEATURE_DATABASE, ORM_FEATURE_DSN) through connectCatalog. The read case only reads; the mutation
// case inserts, updates and deletes one row of composite_account in tenant 990005 and ends in the state it started in.
import assert from 'node:assert/strict';
import { connectCatalog } from '../dist/index.js';

const TENANT = 990005;

async function connect() {
  const driver = process.env.ORM_FEATURE_DATABASE;
  if (!['mysql', 'postgres', 'sqlite'].includes(driver)) {
    throw new Error('ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run it through make feature-check');
  }
  const catalog = await connectCatalog(process.env.ORM_FEATURE_DSN);
  assert.equal(catalog.dialect, driver, 'ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE');
  return { driver, catalog };
}

const quote = (name, driver) => (driver === 'mysql' ? `\`${name}\`` : `"${name}"`);

async function readCase() {
  const { driver, catalog } = await connect();
  try {
    const namespace = await catalog.currentNamespace();
    const author = { namespace, name: 'author' };
    const meta = await catalog.describeTable(author);
    assert.deepEqual(meta.primaryKey, ['seq'], `${driver}: author key`);
    assert.equal(meta.reliableRowIdentity, true, `${driver}: author row identity`);
    assert.ok(meta.columns.some(c => c.name === 'start_dt'), `${driver}: author columns lack start_dt`);

    const page = await catalog.tablePage(author, 3, 0);
    assert.deepEqual(page.orderBy, ['seq'], `${driver}: page order`);
    assert.equal(page.hasMore, true, `${driver}: more author rows follow`);
    assert.equal(page.result.rows.length, 3, `${driver}: author page rows`);

    const count = await catalog.readOnlyQuery(`SELECT COUNT(*) FROM ${quote('user', driver)}`, []);
    assert.equal(Number(count.rows[0][0]), 5000, `${driver}: user count`);
    await assert.rejects(
      catalog.readOnlyQuery(`UPDATE ${quote('user', driver)} SET name = name WHERE seq = 1`, []),
      /QUERY_READ_ONLY/,
      `${driver}: a write through readOnlyQuery`,
    );
  } finally {
    await catalog.close();
  }
}

async function mutationCase() {
  const { driver, catalog } = await connect();
  try {
    const account = quote('composite_account', driver);
    const countSql = `SELECT COUNT(*) FROM ${account} WHERE tenant_id = ${TENANT}`;
    const tenantRows = async () => Number((await catalog.readOnlyQuery(countSql, [])).rows[0][0]);
    assert.equal(await tenantRows(), 0, `${driver}: a composite_account row of the test tenant already exists`);

    const table = { namespace: await catalog.currentNamespace(), name: 'composite_account' };
    const meta = await catalog.describeTable(table);
    const inserted = await catalog.insertRow(meta, [
      { name: 'tenant_id', value: TENANT },
      { name: 'account_id', value: 1 },
      { name: 'name', value: 'catalog' },
    ]);
    assert.equal(inserted.rows.length, 1, `${driver}: inserted rows`);

    const find = async (wantName) => {
      const page = await catalog.tablePage(table, 1000, 0);
      assert.equal(page.hasMore, false, `${driver}: composite_account has more rows than one page`);
      const index = page.result.rows.findIndex(row => row[page.columnIndex('tenant_id')] === TENANT);
      assert.ok(index >= 0, `${driver}: no row of the test tenant`);
      assert.equal(page.result.rows[index][page.columnIndex('name')], wantName, `${driver}: name`);
      return catalog.rowSnapshotFromPage(page, index);
    };

    const updated = await catalog.updateRow(await find('catalog'), [{ name: 'name', value: 'catalog-updated' }]);
    assert.equal(updated.rows.length, 1, `${driver}: updated rows`);
    assert.equal(await catalog.deleteRow(await find('catalog-updated')), 1, `${driver}: deleted rows`);
    assert.equal(await tenantRows(), 0, `${driver}: rows left`);
  } finally {
    await catalog.close();
  }
}

await readCase();
await mutationCase();
console.log('catalog_connection: read and row mutation passed');
