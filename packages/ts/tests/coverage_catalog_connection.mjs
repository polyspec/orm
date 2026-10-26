// catalog_connection coverage runs the two shared cases against the bench database that the
// feature check selected (ORM_FEATURE_DATABASE, ORM_FEATURE_DSN) through connectCatalog. The read case only reads; the mutation
// case inserts, updates and deletes one row of composite_account in tenant 990005 and ends in the state it started in.
// Requirements: SCH-3, SCH-5, SCH-6, SCH-6a, INT-97, INT-101, INT-102, INT-103, INT-104, INT-109, INT-112, INT-113, INT-114, INT-115, INT-121, INT-123, INT-136, INT-117.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeQuery, runCases } from './coverage_case.mjs';
import { BindCell, connect as connectModel, connectCatalog, decode } from '../dist/index.js';
import { DatabaseSync } from 'node:sqlite';

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
    const directory = mkdtempSync(join(tmpdir(), 'orm-catalog-missing-'));
    const path = join(directory, 'missing.sqlite');
    try {
      await assert.rejects(connectCatalog(`sqlite://${path}`));
      assert.equal(existsSync(path), false, `${driver}: catalog connection created a missing SQLite database`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    const namespace = await catalog.currentNamespace();
    const author = { namespace, name: 'author' };
    const meta = await catalog.describeTable(author);
    assert.deepEqual(meta.primaryKey, ['seq'], `${driver}: author key`);
    assert.equal(meta.reliableRowIdentity, true, `${driver}: author row identity`);
    assert.ok(meta.columns.some(c => c.name === 'start_dt'), `${driver}: author columns lack start_dt`);
    const metadataName = `catalog_metadata_${process.pid}_${randomInt(0, 1_000_000_000)}`;
    try {
      await nativeQuery(driver, item.dsn, [
        `CREATE TABLE ${quote(metadataName, driver)} (a BIGINT NOT NULL, b BIGINT NOT NULL, note VARCHAR(50), g BIGINT GENERATED ALWAYS AS (a+1) STORED, PRIMARY KEY (b,a))`,
      ]);
      const metadata = await catalog.describeTable({ namespace, name: metadataName });
      const wantNativeTypes = driver === 'mysql'
        ? ['bigint', 'bigint', 'varchar(50)', 'bigint']
        : driver === 'postgres'
          ? ['bigint', 'bigint', 'character varying(50)', 'bigint']
          : ['BIGINT', 'BIGINT', 'VARCHAR(50)', 'BIGINT'];
      assert.deepEqual(metadata.columns.map(column => column.name), ['a', 'b', 'note', 'g'], `${driver}: physical metadata column order`);
      assert.deepEqual(metadata.columns.map(column => column.nativeType), wantNativeTypes, `${driver}: native column types`);
      assert.deepEqual(metadata.primaryKey, ['b', 'a'], `${driver}: primary-key constraint order`);
      assert.equal(metadata.columns[2].nullable, true, `${driver}: actual nullable column`);
      assert.equal(metadata.columns[3].generated, true, `${driver}: generated-column flag`);
      assert.equal(metadata.reliableRowIdentity, true, `${driver}: non-null primary-key identity`);
    } finally {
      await nativeQuery(driver, item.dsn, [`DROP TABLE IF EXISTS ${quote(metadataName, driver)}`]);
    }

    const page = await catalog.tablePage(author, 3, 0);
    assert.deepEqual(page.orderBy, ['seq'], `${driver}: page order`);
    assert.equal(page.hasMore, true, `${driver}: more author rows follow`);
    assert.equal(page.result.rows.length, 3, `${driver}: author page rows`);
    assert.deepEqual(page.result.columns, meta.columns.map(column => column.name), `${driver}: page columns follow descriptor order`);
    for (const [limit, offset] of [[0, 0], [1001, 0], [1, 1_000_001]]) {
      await assert.rejects(catalog.tablePage(author, limit, offset), `${driver}: table page bounds ${limit}/${offset}`);
    }

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
      await catalog.readOnlyGridQuery(sql);
    }
    const readOnlyRefusals = [
      'COMMIT',
      'CALL missing_catalog_procedure()',
      'SELECT 1 INTO catalog_forbidden',
      'SELECT 1 FOR UPDATE',
      'SELECT 1; SELECT 2',
      'WITH changed AS (UPDATE user SET name=name WHERE seq=1 RETURNING seq) SELECT seq FROM changed',
    ];
    if (driver === 'postgres') {
      readOnlyRefusals.push(`SELECT ${Array(200).fill('1').join(' UNION ALL ')}`);
      readOnlyRefusals.push(`SELECT ${Array(200).fill('1').join('+')}`);
    }
    for (const sql of readOnlyRefusals) {
      await assert.rejects(catalog.readOnlyGridQuery(sql), /QUERY_READ_ONLY/, `${driver}: read-only grid refusal: ${sql}`);
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
    const capturedPage = await catalog.tablePage(table, 1000, 0);
    assert.throws(
      () => catalog.rowSnapshotFromPage({ ...capturedPage, orderBy: [] }, 0),
      codeIs('ROW_SNAPSHOT_INVALID'),
      `${driver}: page order that differs from the descriptor is rejected`,
    );

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
    assert.deepEqual(original.keys(), [TENANT, 1], `${driver}: snapshot key cells follow constraint order`);
    const originalCells = original.originalCells();
    const originalRevision = original.revision;
    for (const values of [
      [{ name: 'name', value: 'first' }, { name: 'name', value: 'second' }],
      [{ name: 'absent', value: 'value' }],
      [{ name: 'name', value: null }],
      [{ name: 'name', value: 'x'.repeat(192) }],
    ]) {
      await assert.rejects(catalog.updateRow(original, values), codeIs('ROW_UPDATE_INVALID'), `${driver}: invalid assignment is rejected`);
    }
    assert.equal((await find('catalog')).revision, originalRevision, `${driver}: rejected assignments leave the stored row unchanged`);
    const updated = await catalog.updateRow(original, [{ name: 'name', value: 'catalog-updated' }]);
    assert.equal(updated.rows.length, 1, `${driver}: updated rows`);
    assert.deepEqual(original.originalCells(), originalCells, `${driver}: captured cells remain immutable`);
    assert.equal(original.revision, originalRevision, `${driver}: captured revision remains immutable`);
    await assert.rejects(
      catalog.updateRow(original, [{ name: 'name', value: 'stale' }]),
      codeIs('ROW_CONFLICT'),
      `${driver}: update of the stale original row is rejected`,
    );
    const current = await find('catalog-updated');
    assert.equal(await catalog.deleteRow(current), 1, `${driver}: deleted rows`);
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

// Requirements: INT-115.
async function plainReadBoundsCase(item) {
  const { driver, catalog } = await connect(item);
  try {
    const rows = "SELECT 'alpha' AS value UNION ALL SELECT 'beta' AS value";
    await assert.rejects(
      catalog.readOnlyQuery(rows, [], { maxRows: 1 }),
      codeIs('CATALOG_LIMIT'),
      `${driver}: the row limit rejects a partial result`,
    );
    const exactRows = await catalog.readOnlyQuery(rows, [], { maxRows: 2 });
    assert.deepEqual(exactRows.rows, [['alpha'], ['beta']], `${driver}: the exact row limit returns all rows`);

    const bytes = "SELECT 'abc' AS value";
    await assert.rejects(
      catalog.readOnlyQuery(bytes, [], { maxRows: 2, maxBytes: 2 }),
      codeIs('CATALOG_LIMIT'),
      `${driver}: the byte limit rejects a partial result`,
    );
    const exactBytes = await catalog.readOnlyQuery(bytes, [], { maxRows: 2, maxBytes: 3 });
    assert.deepEqual(exactBytes.rows, [['abc']], `${driver}: the exact byte limit returns the row`);
  } finally {
    await catalog.close();
  }
}

// Typed grid cells by the native type of each column (the Rust grid rules). Each row of cells is compared with its exact cells.
async function assertGridCells(driver, catalog) {
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
}

async function gridCase() {
  const { driver, catalog } = await connect();
  try {
    await assertGridCells(driver, catalog);
  } finally {
    await catalog.close();
  }
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

// A described temporal column reads with exactly the fraction digits its declared precision fixes: the native type for MySQL and
// PostgreSQL, the dbspec CHECK of the table for SQLite. A value with other digits fails with GRID_TEMPORAL_PRECISION.
async function precisionCase() {
  const { driver, catalog } = await connect();
  try {
    const page = await catalog.tablePage({ namespace: await catalog.currentNamespace(), name: 'author' }, 3, 0);
    const index = page.columnIndex('start_dt');
    const column = page.metadata.columns[index];
    if (column !== undefined && /TIME|DATETIME|TIMESTAMP/i.test(column.nativeType)) {
      const declared = /\((\d+)\)/.exec(column.nativeType);
      const precision = driver === 'sqlite'
        ? column.checkPrecision
        : declared ? Number(declared[1]) : driver === 'postgres' ? 6 : 0;
      assert.notEqual(precision, null, `${driver}: start_dt has a precision its CHECK or type fixes`);
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

// SQLite temporal rules of a described table, on tables this case creates in the bench file and drops afterwards: a value in the
// dbspec form with the digits its CHECK fixes reads back; a value that is no dbspec text fails with GRID_TEMPORAL_VALUE; a column with
// no CHECK that fixes its digits fails with GRID_TEMPORAL_PRECISION.
async function sqliteTemporalCase() {
  if (process.env.ORM_FEATURE_DATABASE !== 'sqlite') return;
  const path = decodeURIComponent(new URL(process.env.ORM_FEATURE_DSN).pathname);
  const db = new DatabaseSync(path);
  const names = ['kcat_temporal_ok', 'kcat_temporal_bare', 'kcat_temporal_nocheck'];
  try {
    for (const name of names) db.exec(`DROP TABLE IF EXISTS ${name}`);
    db.exec(`CREATE TABLE kcat_temporal_ok (id INTEGER PRIMARY KEY, a DATETIME CHECK ("a" IS NULL OR (length("a") = 23 AND substr("a", 1, 19) IS datetime(substr("a", 1, 19)) AND substr("a", 12, 2) < '24' AND substr("a", 20, 1) = '.' AND substr("a", 21) GLOB '[0-9][0-9][0-9]')))`);
    db.exec(`INSERT INTO kcat_temporal_ok (id, a) VALUES (1, '2026-01-02 03:04:05.123')`);
    db.exec(`CREATE TABLE kcat_temporal_bare (id INTEGER PRIMARY KEY, b DATETIME)`);
    db.exec(`INSERT INTO kcat_temporal_bare (id, b) VALUES (1, 'not a datetime')`);
    db.exec(`CREATE TABLE kcat_temporal_nocheck (id INTEGER PRIMARY KEY, b DATETIME)`);
    db.exec(`INSERT INTO kcat_temporal_nocheck (id, b) VALUES (1, '2026-01-02 03:04:05.123')`);
    const catalog = await connectCatalog(process.env.ORM_FEATURE_DSN);
    try {
      const ok = await catalog.tablePage({ namespace: 'main', name: 'kcat_temporal_ok' }, 1, 0);
      assert.equal(ok.result.rows[0][1], '2026-01-02 03:04:05.123', 'sqlite: a dbspec datetime reads back as its text');
      await assert.rejects(catalog.tablePage({ namespace: 'main', name: 'kcat_temporal_bare' }, 1, 0), codeIs('GRID_TEMPORAL_VALUE'), 'sqlite: a non-dbspec text');
      await assert.rejects(catalog.tablePage({ namespace: 'main', name: 'kcat_temporal_nocheck' }, 1, 0), codeIs('GRID_TEMPORAL_PRECISION'), 'sqlite: no CHECK fixes the digits');
    } finally {
      await catalog.close();
    }
  } finally {
    for (const name of names) db.exec(`DROP TABLE IF EXISTS ${name}`);
    db.close();
  }
}

// The byte budget counts each cell by its converted size (sizeOf, gridSize): an integer and a boolean are 8 bytes, text is its UTF-8 bytes,
// binary its length. A read of exactly the budget succeeds, one byte less fails. An integer that a driver returns as text is still 8 bytes.
async function byteBudgetCase() {
  const { driver, catalog } = await connect();
  try {
    const big = await catalog.readOnlyQuery('SELECT 9223372036854775807 AS n', [], { maxBytes: 8 });
    assert.equal(big.rows[0][0], 9223372036854775807n, `${driver}: a big integer within its 8 bytes`);
    await assert.rejects(catalog.readOnlyQuery('SELECT 9223372036854775807 AS n', [], { maxBytes: 7 }), codeIs('CATALOG_LIMIT'), `${driver}: 7 bytes do not hold an 8-byte integer`);
    const two = "SELECT 1 AS a UNION ALL SELECT 2";
    assert.equal((await catalog.readOnlyQuery(two, [], { maxBytes: 16 })).rows.length, 2, `${driver}: two integers in 16 bytes`);
    await assert.rejects(catalog.readOnlyQuery(two, [], { maxBytes: 15 }), codeIs('CATALOG_LIMIT'), `${driver}: two integers in 15 bytes`);
    const accent = await catalog.readOnlyQuery("SELECT 'é' AS t", [], { maxBytes: 2 });
    assert.equal(accent.rows[0][0], 'é', `${driver}: a two-byte character in two bytes`);
    await assert.rejects(catalog.readOnlyQuery("SELECT 'é' AS t", [], { maxBytes: 1 }), codeIs('CATALOG_LIMIT'), `${driver}: the UTF-8 bytes, not the characters`);
    const grid = await catalog.readOnlyGridQuery(driver === 'postgres' ? 'SELECT 1.5::double precision' : driver === 'mysql' ? 'SELECT CAST(1.5 AS DOUBLE)' : 'SELECT 1.5', [], { maxBytes: 8 });
    assert.equal(grid.rows[0][0].kind, 'float64', `${driver}: a double in 8 bytes`);
    await assert.rejects(catalog.readOnlyGridQuery("SELECT 'é'", [], { maxBytes: 1 }), codeIs('CATALOG_LIMIT'), `${driver}: a grid text counts its UTF-8 bytes`);
  } finally {
    await catalog.close();
  }
}

// float4 of PostgreSQL is rounded from its exact text, and the single-precision bits are those of the nearest float4 (ties to even).
async function floatCase() {
  const { driver, catalog } = await connect();
  try {
    if (driver === 'postgres') {
      const bits = async (sql) => (await catalog.readOnlyGridQuery(sql, [])).rows[0][0];
      assert.deepEqual(await bits('SELECT 16777216::real'), { kind: 'float32', bits: 1266679808 }, 'postgres: 2^24 is exact');
      assert.deepEqual(await bits('SELECT 16777218::real'), { kind: 'float32', bits: 1266679809 }, 'postgres: 2^24 + 2 is the next float4');
      assert.deepEqual(await bits("SELECT '1e-45'::real"), { kind: 'float32', bits: 1 }, 'postgres: the least subnormal float4');
      assert.deepEqual(await bits("SELECT '-1.17549435e-38'::real"), { kind: 'float32', bits: 2155872256 }, 'postgres: the least normal float4, negative');
      assert.deepEqual(await bits("SELECT '3.4028235e+38'::real"), { kind: 'float32', bits: 2139095039 }, 'postgres: the largest float4');
      assert.deepEqual(await bits("SELECT 'NaN'::real"), { kind: 'float32', bits: 2143289344 }, 'postgres: NaN float4');
      const plain = await catalog.readOnlyQuery('SELECT 1.1::real AS f', []);
      assert.equal(plain.rows[0][0], Math.fround(1.1), 'postgres: a float4 reads as its exact single-precision value');
    }
  } finally {
    await catalog.close();
  }
}

// SCH-6a: an operation on a catalog connection after close fails with CATALOG_CLOSED and sends no statement. The writes use the
// key of an existing author row, so a missing check would report a conflict or write the same value back.
async function closedCase() {
  const { driver, catalog } = await connect();
  const namespace = await catalog.currentNamespace();
  const author = { namespace, name: 'author' };
  const meta = await catalog.describeTable(author);
  const page = await catalog.tablePage(author, 1, 0);
  const snapshot = catalog.rowSnapshotFromPage(page, 0);
  const seq = page.result.rows[0][0];
  await catalog.close();
  const attempts = {
    currentNamespace: () => catalog.currentNamespace(),
    describeTable: () => catalog.describeTable(author),
    tablePage: () => catalog.tablePage(author, 1, 0),
    readOnlyQuery: () => catalog.readOnlyQuery('SELECT 1', []),
    readOnlyGridQuery: () => catalog.readOnlyGridQuery('SELECT 1', []),
    insertRow: () => catalog.insertRow(meta, [{ name: 'seq', value: seq }]),
    updateRow: () => catalog.updateRow(snapshot, [{ name: 'seq', value: seq }]),
    deleteRow: () => catalog.deleteRow(snapshot),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    await assert.rejects(
      attempt(),
      error => {
        assert.equal(error.code, 'CATALOG_CLOSED', `${driver}: ${name} after close: ${error.code}: ${error.message}`);
        return true;
      },
      `${driver}: ${name} after close did not fail`,
    );
  }
  // Nothing was destroyed: a reopened connection still reads the first author row, which deleteRow was given.
  const reopened = await connectCatalog(process.env.ORM_FEATURE_DSN);
  try {
    const after = await reopened.tablePage(author, 1, 0);
    assert.equal(after.result.rows.length, 1, `${driver}: author is empty after deleteRow on a closed connection`);
    assert.equal(after.result.rows[0][0], seq, `${driver}: the first author row changed or is gone after deleteRow on a closed connection`);
  } finally {
    await reopened.close();
  }
}

const featureCases = {
  catalog_read: readCase,
  catalog_grid_column_and_row_order: gridColumnAndRowOrderCase,
  catalog_plain_query_bounds: plainReadBoundsCase,
  model_read_null_and_empty_text: nullAndEmptyTextCase,
  catalog_row_mutation: mutationCase,
};
if (process.env.NODE_TEST_CONTEXT !== undefined || process.argv.length > 2) {
  await runCases('coverage_catalog_connection.mjs', featureCases, 120_000);
} else {
  await readCase();
  await mutationCase();
  await plainCase();
  await streamCase();
  await plainReadBoundsCase();
  await gridCase();
  await precisionCase();
  await sqliteTemporalCase();
  await byteBudgetCase();
  await floatCase();
  await closedCase();
  console.log('catalog_connection: read, row mutation, columns, stream budgets, byte budgets, grid cells, float and temporal precision, closed connection passed');
}
