// catalog_connection native coverage for the TypeScript parity ids (catalog_read, catalog_grid_column_and_row_order,
// model_read_null_and_empty_text, catalog_row_mutation). The recipe contracts/fixtures/catalog_connection/catalog_connection.json,
// run by catalog-connection-check/typescript, covers the assertions of these functions; they stay until parity.json names the recipe.
// Requirements: SCH-3, SCH-5, SCH-6, SCH-6a, INT-97, INT-101, INT-102, INT-103, INT-104, INT-109, INT-112, INT-113, INT-114, INT-115, INT-121, INT-123, INT-136, INT-117.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { nativeQuery, runCases } from './coverage_case.mjs';
import { BindCell, connect as connectModel, connectCatalog, decode } from '../dist/index.js';

const TENANT = 990005;

async function connect(item = {
  driver: process.env.ORM_FEATURE_DATABASE,
  dsn: process.env.ORM_FEATURE_DSN,
}) {
  const { driver, dsn } = item;
  if (!['mysql', 'postgres', 'sqlite'].includes(driver)) {
    throw new Error('a catalog coverage item must name mysql, postgres or sqlite; run it through make feature-check');
  }
  const catalog = await connectCatalog(dsn);
  assert.equal(catalog.dialect, driver, 'ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE');
  return { driver, catalog };
}

const quote = (name, driver) => (driver === 'mysql' ? `\`${name}\`` : `"${name}"`);

// Requirements: INT-101, INT-121, INT-136, INT-117.
async function readCase(item) {
  const { driver, catalog } = await connect(item);
  try {
    await assert.rejects(connectCatalog('unsupported://host/database'));
    const namespace = await catalog.currentNamespace();
    const author = { namespace, name: 'author' };
    const meta = await catalog.describeTable(author);

    const page = await catalog.tablePage(author, 3, 0);
    assert.deepEqual(page.orderBy, ['seq'], `${driver}: page order`);
    assert.equal(page.hasMore, true, `${driver}: more author rows follow`);
    assert.equal(page.result.rows.length, 3, `${driver}: author page rows`);
    assert.deepEqual(page.result.columns.map(column => column.name), meta.columns.map(column => column.name), `${driver}: page columns follow descriptor order`);

    const count = await catalog.readOnlyQuery(`SELECT COUNT(*) FROM ${quote('user', driver)}`, []);
    assert.equal(Number(count.rows[0][0]), 5000, `${driver}: user count`);
    if (driver === 'mysql') {
      const name = `catalog_readonly_${process.pid}_${randomInt(0, 1_000_000_000)}`;
      const fn = `${name}_fn`;
      try {
        await nativeQuery(driver, item.dsn, [
          `CREATE TABLE ${quote(name, driver)} (n INTEGER NOT NULL)`,
          `INSERT INTO ${quote(name, driver)} VALUES (7)`,
          `CREATE FUNCTION ${quote(fn, driver)}() RETURNS INTEGER DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE ${quote(name, driver)} SET n=n+1; RETURN 1; END`,
        ]);
        await assert.rejects(
          catalog.readOnlyGridQuery(`SELECT ${quote(fn, driver)}()`, []),
          undefined,
          `${driver}: a database-enforced read-only scope allowed a function to write`,
        );
      } finally {
        await nativeQuery(driver, item.dsn, [
          `DROP FUNCTION IF EXISTS ${quote(fn, driver)}`,
          `DROP TABLE IF EXISTS ${quote(name, driver)}`,
        ]);
      }
    } else {
      const readOnlySQL = driver === 'postgres'
        ? "SELECT current_setting('transaction_read_only')"
        : 'SELECT query_only FROM pragma_query_only';
      const readOnlyState = await catalog.readOnlyQuery(readOnlySQL, []);
      assert.deepEqual(readOnlyState.rows, [[driver === 'postgres' ? 'on' : 1]], `${driver}: query runs in a database-enforced read-only scope`);
    }
    if (driver === 'mysql') {
      const classification = await catalog.readOnlyQuery(
        "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'information_schema' AND TABLE_NAME = 'TABLES'",
        [],
      );
      assert.deepEqual(classification.rows, [['SYSTEM VIEW']], 'information_schema.TABLES is a MySQL SYSTEM VIEW');
      const systemView = await catalog.describeTable({ namespace: 'information_schema', name: 'TABLES' });
      assert.equal(systemView.kind, 'view', 'a MySQL SYSTEM VIEW is described as a view');
      assert.ok(systemView.columns.length > 0, 'a MySQL SYSTEM VIEW retains its columns');
      assert.deepEqual(systemView.primaryKey, [], 'a MySQL SYSTEM VIEW has no row identity');
      assert.equal(systemView.reliableRowIdentity, false, 'a MySQL SYSTEM VIEW is not a reliable row identity');
    }
    await temporalDefaultPrecisionCase(driver, item.dsn, catalog);
    await assert.rejects(
      catalog.readOnlyQuery(`UPDATE ${quote('user', driver)} SET name = name WHERE seq = 1`, []),
      /QUERY_READ_ONLY/,
      `${driver}: a write through readOnlyQuery`,
    );
    for (const sql of ["SELECT ';' AS value /* ; */", 'WITH values_cte AS (SELECT 1 AS value) SELECT value FROM values_cte']) {
      await catalog.readOnlyGridQuery(sql, []);
    }
    const readOnlyRefusals = [
      'COMMIT',
      'CALL missing_catalog_procedure()',
      'SELECT 1 INTO catalog_forbidden',
      'SELECT 1 FOR UPDATE',
      'SELECT 1; SELECT 2',
      'WITH changed AS (UPDATE user SET name=name WHERE seq=1 RETURNING seq) SELECT seq FROM changed',
    ];
    for (const sql of readOnlyRefusals) {
      await assert.rejects(catalog.readOnlyGridQuery(sql, []), /QUERY_READ_ONLY/, `${driver}: read-only grid refusal: ${sql}`);
    }
    if (driver === 'postgres') {
      const manyRows = Array(200).fill('SELECT 1').join(' UNION ALL ');
      const longExpression = `SELECT ${Array(200).fill('1').join('+')}`;
      await assert.rejects(
        catalog.readOnlyGridQuery(manyRows, [], { maxRows: 199 }),
        codeIs('CATALOG_LIMIT'),
        `${driver}: bounded read grid stops at the first row past its limit`,
      );
      await assert.rejects(
        catalog.readOnlyGridQuery(longExpression, [], { maxBytes: 7 }),
        codeIs('CATALOG_LIMIT'),
        `${driver}: bounded read grid stops when a value exceeds its byte limit`,
      );
    }
    await assertGridCells(driver, catalog);
  } finally {
    await catalog.close();
  }
}


// Requirements: INT-101, INT-117.
async function temporalDefaultPrecisionCase(driver, dsn, catalog) {
  const name = `catalog_temporal_precision_${process.pid}_${randomInt(0, 1_000_000_000)}`;
  const columns = driver === 'mysql'
    ? 'id BIGINT NOT NULL PRIMARY KEY, t0 TIME NULL, dt0 DATETIME NULL, t3 TIME(3) NULL, dt3 DATETIME(3) NULL'
    : driver === 'postgres'
      ? 'id BIGINT NOT NULL PRIMARY KEY, t0 TIME WITHOUT TIME ZONE NULL, dt0 TIMESTAMP WITHOUT TIME ZONE NULL, t3 TIME(3) WITHOUT TIME ZONE NULL, dt3 TIMESTAMP(3) WITHOUT TIME ZONE NULL'
      : `id INTEGER NOT NULL PRIMARY KEY,
        t0 TIME NOT NULL CHECK (length("t0") = 8 AND "t0" IS time("t0") AND "t0" < '24:00:00'),
        dt0 DATETIME NOT NULL CHECK (length("dt0") = 19 AND "dt0" IS datetime("dt0") AND substr("dt0", 12, 2) < '24'),
        t3 TIME NOT NULL CHECK (length("t3") = 12 AND substr("t3", 1, 8) IS time(substr("t3", 1, 8)) AND "t3" < '24:00:00' AND substr("t3", 9, 1) = '.' AND substr("t3", 10) GLOB '[0-9][0-9][0-9]'),
        dt3 DATETIME NOT NULL CHECK (length("dt3") = 23 AND substr("dt3", 1, 19) IS datetime(substr("dt3", 1, 19)) AND substr("dt3", 12, 2) < '24' AND substr("dt3", 20, 1) = '.' AND substr("dt3", 21) GLOB '[0-9][0-9][0-9]')`;
  try {
    await nativeQuery(driver, dsn, [
      `DROP TABLE IF EXISTS ${name}`,
      `CREATE TABLE ${name} (${columns})`,
    ]);
    const metadata = await catalog.describeTable({ namespace: await catalog.currentNamespace(), name });
    await assert.rejects(catalog.insertRow(metadata, [
      { name: 'id', value: 2 },
      { name: 't0', value: '12:34:56' },
      { name: 'dt0', value: '2026-01-02 03:04:05' },
      { name: 't3', value: '12:34:56.1234' },
      { name: 'dt3', value: '2026-01-02 03:04:05.1234' },
    ]), undefined, `${driver}: typed write beyond declared precision is rejected`);
    const unchanged = await catalog.readOnlyQuery(`SELECT COUNT(*) FROM ${quote(name, driver)} WHERE id=2`, []);
    assert.equal(Number(unchanged.rows[0][0]), 0, `${driver}: rejected typed write rolled back`);
    const t0 = driver === 'postgres' ? '12:34:56.123456' : '12:34:56';
    const dt0 = driver === 'postgres' ? '2026-01-02 03:04:05.123456' : '2026-01-02 03:04:05';
    const inserted = await catalog.insertRow(metadata, [
      { name: 'id', value: 1 },
      { name: 't0', value: t0 },
      { name: 'dt0', value: dt0 },
      { name: 't3', value: '12:34:56.123' },
      { name: 'dt3', value: '2026-01-02 03:04:05.123' },
    ]);
    assert.equal(inserted.rows.length, 1, `${driver}: typed temporal Catalog insert returned its row`);
    const page = await catalog.tablePage({ namespace: await catalog.currentNamespace(), name }, 1, 0);
    const fractions = page.result.rows[0].slice(1).map(value => {
      if (typeof value !== 'string') return value.microsecond === 0 ? 0 : 6;
      const dot = value.indexOf('.');
      return dot === -1 ? 0 : value.length - dot - 1;
    });
    assert.deepEqual(fractions, driver === 'postgres' ? [6, 6, 3, 3] : [0, 0, 3, 3], `${driver}: typed temporal writes read back at declared precision`);
  } finally {
    await nativeQuery(driver, dsn, [`DROP TABLE IF EXISTS ${name}`]);
  }
  if (driver === 'mysql') {
    const invalid = `${name}_invalid`;
    try {
      await assert.rejects(
        nativeQuery(driver, dsn, [`CREATE TABLE ${invalid} (id BIGINT PRIMARY KEY, t TIME(7))`]),
        /precision/i,
        'MySQL rejects temporal precision above 6',
      );
    } finally {
      await nativeQuery(driver, dsn, [`DROP TABLE IF EXISTS ${invalid}`]);
    }
  }
}

// Requirements: COD-31, INT-4, INT-8.
async function nullAndEmptyTextCase(item) {
  const seq = -1_000_000_000_000 - randomInt(0, 1_000_000_000);
  const { catalog } = await connect(item);
  const table = { namespace: await catalog.currentNamespace(), name: 'bind_cell' };
  const metadata = await catalog.describeTable(table);
  const db = await connectModel(item.dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
  let sqliteSequence;
  if (item.driver === 'sqlite') {
    const [[sequenceTable]] = await nativeQuery(item.driver, item.dsn, [
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
    ]);
    assert.ok(sequenceTable, 'SQLite bench schema has sqlite_sequence');
    const [sequenceRows] = await nativeQuery(item.driver, item.dsn, [
      "SELECT quote(seq) AS seq FROM sqlite_sequence WHERE name = 'bind_cell'",
    ]);
    sqliteSequence = sequenceRows[0]?.seq ?? null;
  }
  try {
    await catalog.insertRow(metadata, [
      { name: 'seq', value: seq }, { name: 'label', value: 'null-v' }, { name: 'body', value: null },
    ]);
    await catalog.insertRow(metadata, [
      { name: 'seq', value: seq - 1 }, { name: 'label', value: 'empty' }, { name: 'body', value: '' },
    ]);

    const nullRead = await new BindCell().connect(db).seq(seq).get();
    const emptyRead = await new BindCell().connect(db).seq(seq - 1).get();
    assert.equal(nullRead.getBody(), null, 'SQL NULL remains null when read through the model');
    assert.equal(emptyRead.getBody(), '', 'empty text remains an empty string when read through the model');
    assert.throws(() => decode(['ordered_json'], ''), { code: 'CODEC_DECODE' }, 'empty text with ordered_json');
  } finally {
    const snapshots = [];
    for (let offset = 0; ; ) {
      const page = await catalog.tablePage(table, 1000, offset);
      const keyIndex = page.columnIndex('seq');
      page.result.rows.forEach((row, index) => {
        if (row[keyIndex] === seq || row[keyIndex] === seq - 1) snapshots.push(catalog.rowSnapshotFromPage(page, index));
      });
      if (!page.hasMore) break;
      offset += page.result.rows.length;
    }
    for (const snapshot of snapshots) await catalog.deleteRow(snapshot);
    if (item.driver === 'sqlite') {
      await nativeQuery(item.driver, item.dsn, [
        "DELETE FROM sqlite_sequence WHERE name = 'bind_cell'",
        ...(sqliteSequence === null
          ? []
          : [`INSERT INTO sqlite_sequence (name, seq) VALUES ('bind_cell', ${sqliteSequence})`]),
      ]);
    }
    await db.close();
    await catalog.close();
  }
}

// Requirements: DBS-113, INT-106, INT-108, INT-109, INT-110, INT-111.
async function mutationCase(item) {
  const { driver, catalog } = await connect(item);
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

    const original = await find('catalog');
    assert.deepEqual(original.metadata.primaryKey, ['tenant_id', 'account_id'], `${driver}: declared key order`);
    const originalCells = original.originalCells();
    const updated = await catalog.updateRow(original, [{ name: 'name', value: 'catalog-updated' }]);
    assert.equal(updated.rows.length, 1, `${driver}: updated rows`);
    assert.deepEqual(original.originalCells(), originalCells, `${driver}: captured cells remain immutable`);
    const current = await find('catalog-updated');
    assert.equal(await catalog.deleteRow(current), 1, `${driver}: deleted rows`);
    assert.equal(await tenantRows(), 0, `${driver}: rows left`);
  } finally {
    await catalog.close();
  }
}

const codeIs = (code) => (error) => error?.code === code;

// Typed grid cells by the native type of each column (the Rust grid rules). Each row of cells is compared with its exact cells.
async function assertGridCells(driver, catalog) {
  const first = async (sql) => (await catalog.readOnlyGridQuery(sql, [])).rows[0];
  const rejects = (sql, code) => assert.rejects(catalog.readOnlyGridQuery(sql, []), codeIs(code), `${driver}: ${sql}`);
  const f64 = (bits) => ({ kind: 'float64', bits });
  const text = (value) => ({ kind: 'text', value });
  const shared = [
  ];
  const dialect = {
    mysql: [
      ["SELECT CAST('2020-01-02 03:04:05.25' AS DATETIME(2))", [{ kind: 'datetime', value: '2020-01-02 03:04:05.250000' }]],
      ["SELECT CAST('2020-01-02' AS DATE)", [{ kind: 'date', value: '2020-01-02' }]],
    ],
    postgres: [
      ["SELECT '-0'::double precision, 'NaN'::double precision", [f64(9223372036854775808n), f64(9221120237041090560n)]],
      ["SELECT '12:34:56.5'::time", [{ kind: 'time', value: '12:34:56.500000' }]],
      ["SELECT '2020-01-02 03:04:05.25'::timestamp", [{ kind: 'datetime', value: '2020-01-02 03:04:05.250000' }]],
      ["SELECT '2020-01-02'::date", [{ kind: 'date', value: '2020-01-02' }]],
      ['SELECT true', [{ kind: 'boolean', value: true }]],
    ],
    sqlite: [
      ['SELECT 1e308*10', [f64(9218868437227405312n)]],
      ["SELECT '12:34:56.5'", [text('12:34:56.5')]],
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
}

async function gridColumnAndRowOrderCase(item) {
  const { driver, catalog } = await connect(item);
  try {
    const result = await catalog.readOnlyGridQuery(
      "SELECT 1 AS seq, 'a' AS label UNION ALL SELECT 2, 'b' UNION ALL SELECT 3, 'c' UNION ALL SELECT 4, 'd' ORDER BY seq DESC",
      [],
    );
    assert.deepEqual(result.columns.map(column => column.name), ['seq', 'label'], `${driver}: grid columns`);
    assert.deepEqual(result.rows, [
      [{ kind: 'integer', value: 4n }, { kind: 'text', value: 'd' }],
      [{ kind: 'integer', value: 3n }, { kind: 'text', value: 'c' }],
      [{ kind: 'integer', value: 2n }, { kind: 'text', value: 'b' }],
      [{ kind: 'integer', value: 1n }, { kind: 'text', value: 'a' }],
    ], `${driver}: grid row order`);
  } finally {
    await catalog.close();
  }
}

const featureCases = {
  catalog_read: readCase,
  catalog_grid_column_and_row_order: gridColumnAndRowOrderCase,
  model_read_null_and_empty_text: nullAndEmptyTextCase,
  catalog_row_mutation: mutationCase,
};
if (process.env.NODE_TEST_CONTEXT !== undefined || process.argv.length > 2) {
  await runCases('coverage_catalog_connection.mjs', featureCases, 120_000);
} else {
  await readCase();
  await mutationCase();
  console.log('catalog_connection: read and row mutation passed');
}
