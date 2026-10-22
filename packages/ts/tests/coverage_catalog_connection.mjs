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


// Every case that streams a large result runs under a deadline: a read that did not stop at its budget would never finish.
function within(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no result within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const codeIs = (code) => (error) => error?.code === code;

// Column names and the plain integer values of each dialect (the Go catalog conversion).
async function plainCase() {
  const { driver, catalog } = await connect();
  try {
    const named = await catalog.readOnlyQuery("SELECT 1 AS a, 'x' AS b", []);
    assert.deepEqual(named.columns, ['a', 'b'], `${driver}: column names`);
    assert.deepEqual(named.rows, [[1, 'x']], `${driver}: plain row`);
    const wide = await catalog.readOnlyQuery('SELECT 9007199254740993 AS n', []);
    assert.equal(wide.rows[0][0], 9007199254740993n, `${driver}: an integer outside the safe range is exact`);
  } finally {
    await catalog.close();
  }
}

// The read budgets stop the stream at the first row past the budget: a cross join of the 5000-row user table would never end otherwise.
async function streamCase() {
  const { driver, catalog } = await connect();
  try {
    const user = quote('user', driver);
    const huge = `SELECT a.seq FROM ${user} a CROSS JOIN ${user} b CROSS JOIN ${user} c`;
    await assert.rejects(within(catalog.readOnlyQuery(huge, [], { maxRows: 3 }), 20000, `${driver}: maxRows`), codeIs('CATALOG_LIMIT'), `${driver}: maxRows stops the read`);
    await assert.rejects(within(catalog.readOnlyGridQuery(huge, [], { maxRows: 3 }), 20000, `${driver}: grid maxRows`), codeIs('CATALOG_LIMIT'), `${driver}: grid maxRows stops the read`);
    await assert.rejects(catalog.readOnlyQuery(`SELECT name FROM ${user}`, [], { maxBytes: 16 }), codeIs('CATALOG_LIMIT'), `${driver}: maxBytes`);
    const exact = await within(catalog.readOnlyQuery(`SELECT seq FROM ${user} ORDER BY seq`, [], { maxRows: 5000 }), 20000, `${driver}: exact budget`);
    assert.equal(exact.rows.length, 5000, `${driver}: a result of exactly maxRows rows is read whole`);
    await assert.rejects(catalog.readOnlyQuery('SELECT 1', [], { maxRows: -1 }), codeIs('QUERY_LIMIT_INVALID'), `${driver}: a negative limit`);
  } finally {
    await catalog.close();
  }
}

// Typed grid cells by the native type of each column (the Rust grid rules). Each row of cells is compared with its exact cells.
async function gridCase() {
  const { driver, catalog } = await connect();
  try {
    const first = async (sql) => (await catalog.readOnlyGridQuery(sql, [])).rows[0];
    const rejects = (sql, code) => assert.rejects(catalog.readOnlyGridQuery(sql, []), codeIs(code), `${driver}: ${sql}`);
    const f64 = (bits) => ({ kind: 'float64', bits });
    const f32 = (bits) => ({ kind: 'float32', bits });
    const int = (value) => ({ kind: 'integer', value });
    const nul = { kind: 'null' };
    const text = (value) => ({ kind: 'text', value });
    const bytes = (...value) => ({ kind: 'binary', value: new Uint8Array(value) });
    const shared = [
      ["SELECT ''", [text('')]],
      ['SELECT NULL', [nul]],
      ['SELECT 9223372036854775807', [int(9223372036854775807n)]],
    ];
    const dialect = {
      mysql: [
        ['SELECT CAST(1.5 AS FLOAT)', [f32(1069547520)]],
        ['SELECT CAST(1.5 AS DOUBLE)', [f64(4609434218613702656n)]],
        ['SELECT CAST(18446744073709551615 AS UNSIGNED)', [{ kind: 'unsigned', value: 18446744073709551615n }]],
        ["SELECT CAST('12:34:56.5' AS TIME(6))", [{ kind: 'time', value: '12:34:56.500000' }]],
        ["SELECT CAST('2020-01-02 03:04:05.25' AS DATETIME(2))", [{ kind: 'datetime', value: '2020-01-02 03:04:05.250000' }]],
        ["SELECT CAST('2020-01-02' AS DATE)", [{ kind: 'date', value: '2020-01-02' }]],
        ['SELECT CAST(1.50 AS DECIMAL(10,2))', [{ kind: 'decimal', value: '1.50' }]],
        ["SELECT X'00FF'", [bytes(0, 255)]],
        ["SELECT X''", [bytes()]],
      ],
      postgres: [
        ['SELECT 1.5::real', [f32(1069547520)]],
        ['SELECT 1.5::double precision', [f64(4609434218613702656n)]],
        ["SELECT '-0'::double precision, 'NaN'::double precision", [f64(9223372036854775808n), f64(9221120237041090560n)]],
        ["SELECT '12:34:56.5'::time", [{ kind: 'time', value: '12:34:56.500000' }]],
        ["SELECT '2020-01-02 03:04:05.25'::timestamp", [{ kind: 'datetime', value: '2020-01-02 03:04:05.250000' }]],
        ["SELECT '2020-01-02'::date", [{ kind: 'date', value: '2020-01-02' }]],
        ['SELECT 1.50::numeric(10,2)', [{ kind: 'decimal', value: '1.50' }]],
        ["SELECT '\\x00ff'::bytea", [bytes(0, 255)]],
        ["SELECT ''::bytea", [bytes()]],
        ['SELECT true', [{ kind: 'boolean', value: true }]],
      ],
      sqlite: [
        ['SELECT 1.5', [f64(4609434218613702656n)]],
        ['SELECT 1e308*10', [f64(9218868437227405312n)]],
        ["SELECT '12:34:56.5'", [text('12:34:56.5')]],
        ["SELECT X'00FF'", [bytes(0, 255)]],
        ["SELECT X''", [bytes()]],
      ],
    }[driver];
    for (const [sql, expected] of [...shared, ...dialect]) {
      assert.deepEqual(await first(sql), expected, `${driver}: grid cells of ${sql}`);
    }
    if (driver === 'mysql') {
      await rejects("SELECT YEAR('2020-01-02')", 'CATALOG_VALUE');
      await rejects("SELECT CAST('-01:00:00' AS TIME)", 'GRID_TEMPORAL_VALUE');
    }
    if (driver === 'postgres') {
      await rejects("SELECT '2020-01-02 03:04:05+00'::timestamptz", 'CATALOG_VALUE');
      await rejects("SELECT '24:00:00'::time", 'GRID_TEMPORAL_VALUE');
      await rejects("SELECT 'infinity'::timestamp", 'GRID_TEMPORAL_VALUE');
    }
    const named = await catalog.readOnlyGridQuery("SELECT 1 AS a, 'x' AS b", []);
    assert.deepEqual(named.columns.map(column => column.name), ['a', 'b'], `${driver}: grid column names`);
  } finally {
    await catalog.close();
  }
}

// A described temporal column reads with exactly the fraction digits its native type declares (GRID_TEMPORAL_PRECISION otherwise).
async function precisionCase() {
  const { driver, catalog } = await connect();
  try {
    const page = await catalog.tablePage({ namespace: await catalog.currentNamespace(), name: 'author' }, 3, 0);
    const index = page.columnIndex('start_dt');
    const column = page.metadata.columns[index];
    // SQLite has no temporal storage class and keeps its stored text (not checked here).
    if (driver !== 'sqlite' && column !== undefined && /TIME|DATETIME|TIMESTAMP/i.test(column.nativeType)) {
      const declared = /\((\d+)\)/.exec(column.nativeType);
      const precision = declared ? Number(declared[1]) : driver === 'postgres' ? 6 : 0;
      for (const row of page.result.rows) {
        const value = row[index];
        const fraction = typeof value === 'string' && value.includes('.') ? value.split('.')[1].length : 0;
        assert.equal(fraction, precision, `${driver}: start_dt of ${column.nativeType} has ${fraction} fraction digits`);
      }
    }
  } finally {
    await catalog.close();
  }
}

await readCase();
await mutationCase();
await plainCase();
await streamCase();
await gridCase();
await precisionCase();
console.log('catalog_connection: read, row mutation, columns, stream budgets, grid cells and precision passed');
