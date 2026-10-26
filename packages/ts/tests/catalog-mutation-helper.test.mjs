import assert from 'node:assert/strict';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CatalogConnection, CatalogRowSnapshot, connectCatalog } from '../dist/catalog.js';
import { openDriver, parseDsn } from '../dist/driver.js';
import { OrmError } from '../dist/runtime_error.js';

const metadata = {
  table: { namespace: 'main', name: 'account' },
  kind: 'table',
  columns: [
    { name: 'id', nativeType: 'INTEGER', nullable: false, generated: false, automaticKey: false, defaultExpression: null, expressionDefault: false, checkPrecision: null },
    { name: 'name', nativeType: 'TEXT', nullable: false, generated: false, automaticKey: false, defaultExpression: null, expressionDefault: false, checkPrecision: null },
  ],
  primaryKey: ['id'],
  reliableRowIdentity: true,
};

function catalogFixturePool(session) {
  return {
    async reserve() { return session; },
    async execute() { throw new Error('unexpected pool execute'); },
    stats() { return { maxOpenConnections: 1, openConnections: 1, inUse: 0, idle: 1 }; },
    async close() {},
  };
}

function mysqlCatalogFixture({ expressionDefault = false, autoKey = false, priorRows = [], postRows } = {}) {
  const queries = [];
  const columns = autoKey
    ? [
        { name: 'id', nativeType: 'bigint', nullable: false, generated: false, automaticKey: true, defaultExpression: null, expressionDefault: false, checkPrecision: null },
        { name: 'payload', nativeType: 'text', nullable: false, generated: false, automaticKey: false, defaultExpression: null, expressionDefault: false, checkPrecision: null },
      ]
    : expressionDefault
    ? [
        { name: 'seq', nativeType: 'varchar(32)', nullable: false, generated: false, automaticKey: false, defaultExpression: 'lower(hex(random_bytes))', expressionDefault: true, checkPrecision: null },
        { name: 'n', nativeType: 'bigint', nullable: false, generated: false, automaticKey: false, defaultExpression: null, expressionDefault: false, checkPrecision: null },
        { name: 'label', nativeType: 'text', nullable: true, generated: false, automaticKey: false, defaultExpression: null, expressionDefault: false, checkPrecision: null },
      ]
    : [
        { name: 'tenant', nativeType: 'bigint', nullable: false, generated: false, automaticKey: false, defaultExpression: null, expressionDefault: false, checkPrecision: null },
        { name: 'seq', nativeType: 'varchar(30)', nullable: false, generated: false, automaticKey: false, defaultExpression: 'generated', expressionDefault: false, checkPrecision: null },
        { name: 'n', nativeType: 'bigint', nullable: false, generated: false, automaticKey: false, defaultExpression: null, expressionDefault: false, checkPrecision: null },
      ];
  const keyOrdinals = new Map((autoKey ? ['id'] : expressionDefault ? ['seq'] : ['tenant', 'seq']).map((name, index) => [name, index + 1]));
  const metadata = {
    table: { namespace: 'app', name: 'generated_record' },
    kind: 'table',
    columns,
    primaryKey: autoKey ? ['id'] : expressionDefault ? ['seq'] : ['tenant', 'seq'],
    reliableRowIdentity: true,
  };
  const stored = autoKey ? [11, 'generated'] : expressionDefault ? ['expression-key-001', 1, null] : [2, 'generated', 50];
  let inserted = false;
  let locatorReads = 0;
  const fieldsFor = names => names.map(name => ({ name, type: columns.find(column => column.name === name)?.nativeType ?? 'varchar' }));
  const rowsFor = (sql) => {
    if (sql.startsWith('SELECT TABLE_TYPE')) return { names: ['TABLE_TYPE'], rows: [['BASE TABLE']] };
    if (sql.startsWith('SELECT c.COLUMN_NAME')) return {
      names: ['COLUMN_NAME', 'COLUMN_TYPE', 'IS_NULLABLE', 'GENERATED', 'ORDINAL_POSITION', 'AUTO_KEY', 'COLUMN_DEFAULT', 'EXPRESSION_DEFAULT'],
      rows: columns.map(column => [column.name, column.nativeType, column.nullable, column.generated,
        keyOrdinals.get(column.name) ?? 0, column.automaticKey, column.defaultExpression, column.expressionDefault]),
    };
    if (sql === 'SELECT CAST(@@GLOBAL.partial_revokes AS SIGNED)') return { names: ['partial_revokes'], rows: [[0]] };
    if (sql === 'SELECT CURRENT_USER()') return { names: ['CURRENT_USER()'], rows: [['orm@localhost']] };
    if (sql.includes('information_schema.USER_PRIVILEGES')) return { names: ['PRIVILEGE_TYPE'], rows: [['TRIGGER']] };
    if (sql.startsWith('SELECT ENGINE')) return { names: ['ENGINE'], rows: [['InnoDB']] };
    if (sql.startsWith('SELECT TRIGGER_NAME')) return { names: ['TRIGGER_NAME'], rows: [] };
    if (sql.startsWith('SELECT ' + columns.map(column => `\`${column.name}\``).join(','))) {
      if (expressionDefault) {
        locatorReads++;
        return { names: columns.map(column => column.name), rows: locatorReads === 1 ? priorRows : (postRows ?? (inserted ? [stored] : [])) };
      }
      if (autoKey && sql.includes('WHERE `id`=?')) return { names: columns.map(column => column.name), rows: inserted ? [stored] : [] };
      if (sql.includes('DEFAULT(`seq`)')) return { names: columns.map(column => column.name), rows: [stored] };
    }
    throw new Error(`unexpected MySQL catalog fixture query: ${sql}`);
  };
  const session = {
    async control(sql) { queries.push(['control', sql]); return { rows: [], affected: 0, insertId: null, columns: [] }; },
    async execute(sql) {
      queries.push(['execute', sql]);
      if (!sql.startsWith('INSERT INTO')) throw new Error(`unexpected MySQL execute: ${sql}`);
      inserted = true;
      return { rows: [], affected: 1, insertId: autoKey ? 11 : null, columns: [] };
    },
    async scan(sql, _params, sink) {
      queries.push(['scan', sql]);
      const result = rowsFor(sql);
      sink.columns(fieldsFor(result.names));
      for (const row of result.rows) sink.row(row);
    },
    release() {},
  };
  return { catalog: new CatalogConnection('mysql', catalogFixturePool(session)), columns, metadata, queries, stored };
}

function postgresCatalogFixture() {
  const queries = [];
  const columns = [
    { name: 'tenant', nativeType: 'bigint', nullable: false, generated: false, automaticKey: false, defaultExpression: null, expressionDefault: false, checkPrecision: null },
    { name: 'seq', nativeType: 'character varying(30)', nullable: false, generated: false, automaticKey: false, defaultExpression: "'generated'", expressionDefault: true, checkPrecision: null },
    { name: 'n', nativeType: 'bigint', nullable: false, generated: false, automaticKey: false, defaultExpression: null, expressionDefault: false, checkPrecision: null },
  ];
  const metadata = {
    table: { namespace: 'app', name: 'generated_record' },
    kind: 'table', columns, primaryKey: ['tenant', 'seq'], reliableRowIdentity: true,
  };
  const stored = [2, 'generated', 50];
  const session = {
    async control(sql) { queries.push(['control', sql]); return { rows: [], affected: 0, insertId: null, columns: [] }; },
    async execute(sql) { throw new Error(`unexpected PostgreSQL execute: ${sql}`); },
    async scan(sql, _params, sink) {
      queries.push(['scan', sql]);
      let names;
      let types;
      let rows;
      if (sql.startsWith('SELECT c.relkind::text')) {
        names = ['relkind']; types = ['text']; rows = [['r']];
      } else if (sql.startsWith('SELECT a.attname::text')) {
        names = ['attname', 'format_type', 'nullable', 'generated', 'key_order', 'automatic_key', 'default_expression', 'expression_default'];
        types = ['text', 'text', 'bool', 'bool', 'int4', 'bool', 'text', 'bool'];
        rows = columns.map((column, index) => [column.name, column.nativeType, column.nullable, column.generated,
          index < 2 ? index + 1 : 0, column.automaticKey, column.defaultExpression, column.expressionDefault]);
      } else if (sql.startsWith('INSERT INTO') && sql.includes('RETURNING')) {
        names = columns.map(column => column.name); types = columns.map(column => column.nativeType); rows = [stored];
      } else {
        throw new Error(`unexpected PostgreSQL catalog fixture query: ${sql}`);
      }
      sink.columns(names.map((name, index) => ({ name, type: types[index] })));
      for (const row of rows) sink.row(row);
    },
    release() {},
  };
  return { catalog: new CatalogConnection('postgres', catalogFixturePool(session)), metadata, queries, stored };
}

async function withSqliteCatalog(prefix, ddl, exercise, connect = connectCatalog) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const path = join(directory, 'catalog.sqlite');
  const database = new DatabaseSync(path);
  try {
    database.exec(ddl);
  } finally {
    database.close();
  }
  let catalog;
  try {
    catalog = await connect(`sqlite://${path}`);
    await exercise(catalog);
  } finally {
    if (catalog !== undefined) await catalog.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function sqliteCatalogWithCommitFailure(dsn, failure, commits, rollbackFailure, rollbacks) {
  const driver = openDriver(dsn, parseDsn(dsn), { size: 1, idleSize: 1, lifetimeMs: 0 }, 256, 0, true);
  const pool = {
    name: 'sqlite',
    execute: (...args) => driver.execute(...args),
    stats: () => driver.stats(),
    close: () => driver.close(),
    async reserve() {
      const session = await driver.reserve();
      return new Proxy(session, {
        get(target, property) {
          if (property === 'control') {
            return (sql, params, done) => {
              if (sql === 'COMMIT') {
                commits.push(sql);
                throw failure;
              }
              if (sql === 'ROLLBACK' && commits.length > 0 && rollbackFailure !== undefined) {
                rollbacks.push(sql);
                throw rollbackFailure;
              }
              return session.control(sql, params, done);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
  return new CatalogConnection('sqlite', pool);
}

/**
 * Inserts one generated_record row through catalog, whose COMMIT response fails with failure, and returns the
 * ROW_COMMIT_INDETERMINATE error that insertRow rejects with: its cause is the DRIVER error of failure, and insertRow
 * returns no result.
 */
async function rejectedIndeterminateInsert(catalog, failure) {
  const descriptor = await catalog.describeTable({ namespace: 'main', name: 'generated_record' });
  let result;
  let rejected;
  await assert.rejects(
    (async () => { result = await catalog.insertRow(descriptor, [{ name: 'payload', value: 'value' }]); })(),
    error => {
      assert.ok(error instanceof OrmError);
      assert.equal(error.code, 'ROW_COMMIT_INDETERMINATE');
      assert.match(error.message, /commit outcome unknown; do not retry/);
      assert.ok(error.cause instanceof OrmError);
      assert.equal(error.cause.code, 'DRIVER');
      assert.strictEqual(error.cause.cause, failure);
      rejected = error;
      return true;
    },
  );
  assert.equal(result, undefined, 'insertRow did not return a success result');
  return rejected;
}

async function assertAmbiguousInsert(catalog, metadata, values) {
  await assert.rejects(
    catalog.insertRow(metadata, values),
    error => error.code === 'ROW_IDENTITY_AMBIGUOUS',
  );
}

async function assertLiteralDefaultCompositeKeyInsert(fixture, checkQueries) {
  const { catalog, metadata, queries, stored } = fixture();
  try {
    const result = await catalog.insertRow(metadata, [
      { name: 'tenant', value: 2 },
      { name: 'n', value: 50 },
    ]);
    assert.deepEqual(result.rows, [stored]);
    checkQueries(queries);
  } finally {
    await catalog.close();
  }
}

caseTest('locks, validates and returns the descriptor of an unchanged original row', DATABASE, async () => {
  const calls = [];
  const session = {
    async lookup(descriptor, keys, lock) {
      calls.push(['lookup', descriptor, keys, lock]);
      return [[1, 'original']];
    },
    async describe(table) {
      calls.push(['describe', table]);
      return metadata;
    },
    async mysqlSafety(descriptor) {
      calls.push(['mysqlSafety', descriptor]);
    },
  };
  const connection = new CatalogConnection('mysql', {});
  const snapshot = new CatalogRowSnapshot(metadata, [1, 'original'], [0], 'revision');

  const descriptor = await connection.lockOriginal(session, snapshot, [1]);

  assert.equal(descriptor, metadata);
  assert.deepEqual(calls, [
    ['lookup', metadata, [1], true],
    ['describe', metadata.table],
    ['mysqlSafety', metadata],
  ]);
});

caseTest('rejects a changed descriptor before applying MySQL safety', DATABASE, async () => {
  let safetyCalled = false;
  const session = {
    async lookup() { return [[1, 'original']]; },
    async describe() { return { ...metadata, table: { namespace: 'main', name: 'changed' } }; },
    async mysqlSafety() { safetyCalled = true; },
  };
  const connection = new CatalogConnection('mysql', {});
  const snapshot = new CatalogRowSnapshot(metadata, [1, 'original'], [0], 'revision');

  await assert.rejects(
    connection.lockOriginal(session, snapshot, [1]),
    error => error instanceof OrmError && error.code === 'ROW_SCHEMA_CHANGED',
  );
  assert.equal(safetyCalled, false);
});

// Requirements: DBS-113, INT-34.
caseTest('uses MySQL DEFAULT(column) to locate a literal-default composite key', DATABASE, async () => {
  await assertLiteralDefaultCompositeKeyInsert(mysqlCatalogFixture, queries => {
    assert.ok(queries.some(([, sql]) => sql.includes('`seq`=DEFAULT(`seq`)')));
    assert.equal(queries.some(([, sql]) => sql.includes('SELECT MAX(') || sql.includes('LAST_INSERT_ID()')), false);
  });
});

// Requirements: DBS-113, INT-34.
caseTest('uses PostgreSQL INSERT RETURNING for a literal-default composite key', DATABASE, async () => {
  await assertLiteralDefaultCompositeKeyInsert(postgresCatalogFixture, queries => {
    assert.ok(queries.some(([, sql]) => sql === 'INSERT INTO "app"."generated_record" ("tenant","n") VALUES ($1,$2) RETURNING "tenant","seq","n"'));
  });
});

// Requirements: DBS-113, INT-34.
caseTest('uses the MySQL statement insertId for an omitted automatic key', DATABASE, async () => {
  const { catalog, metadata, queries, stored } = mysqlCatalogFixture({ autoKey: true });
  try {
    const result = await catalog.insertRow(metadata, [{ name: 'payload', value: 'generated' }]);
    assert.deepEqual(result.rows, [stored]);
    assert.equal(queries.filter(([, sql]) => sql.startsWith('INSERT INTO')).length, 1);
    assert.equal(queries.some(([, sql]) => sql.includes('MAX(') || sql.includes('LAST_INSERT_ID()')), false);
  } finally {
    await catalog.close();
  }
});

caseTest('uses a bounded MySQL input locator for an expression-default key', DATABASE, async () => {
  const { catalog, metadata, queries, stored } = mysqlCatalogFixture({ expressionDefault: true });
  try {
    const result = await catalog.insertRow(metadata, [
      { name: 'n', value: 1 },
      { name: 'label', value: null },
    ]);
    assert.deepEqual(result.rows, [stored]);
    const locatorQueries = queries.filter(([, sql]) => sql.includes('WHERE `n`=? AND `label` IS NULL'));
    assert.equal(locatorQueries.length, 2);
    assert.equal(locatorQueries.every(([, sql]) => sql.includes('LIMIT 2 FOR UPDATE')), true);
    assert.equal(queries.some(([, sql]) => sql.includes('DEFAULT(`seq`)')), false);
  } finally {
    await catalog.close();
  }
});

caseTest('rejects an already-matching MySQL expression locator before inserting', DATABASE, async () => {
  const existing = ['earlier-key', 1, null];
  const { catalog, metadata, queries } = mysqlCatalogFixture({ expressionDefault: true, priorRows: [existing] });
  try {
    await assertAmbiguousInsert(catalog, metadata, [
      { name: 'n', value: 1 },
      { name: 'label', value: null },
    ]);
    assert.equal(queries.some(([kind]) => kind === 'execute'), false);
  } finally {
    await catalog.close();
  }
});

caseTest('reports an ambiguous MySQL expression locator result without changing strategy', DATABASE, async () => {
  const { catalog, metadata, queries } = mysqlCatalogFixture({ expressionDefault: true, postRows: [['first-key', 1, null], ['second-key', 1, null]] });
  try {
    await assertAmbiguousInsert(catalog, metadata, [
      { name: 'n', value: 1 },
      { name: 'label', value: null },
    ]);
    assert.equal(queries.filter(([, sql]) => sql.startsWith('INSERT INTO')).length, 1);
    assert.equal(queries.some(([, sql]) => sql.includes('DEFAULT(`seq`)') || sql.includes('RETURNING')), false);
  } finally {
    await catalog.close();
  }
});

// Requirements: DBS-113, INT-34.
caseTest('inserts an omitted SQLite AUTOINCREMENT key and returns the stored row', DATABASE, async () => {
  await withSqliteCatalog('orm-catalog-auto-key-', 'CREATE TABLE generated_record (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)', async catalog => {
    const metadata = await catalog.describeTable({ namespace: 'main', name: 'generated_record' });
    assert.deepEqual(metadata.primaryKey, ['id']);
    assert.deepEqual(metadata.columns[0], {
      name: 'id', nativeType: 'INTEGER', nullable: false, generated: false, automaticKey: true,
      defaultExpression: null, expressionDefault: false, checkPrecision: null,
    });
    const inserted = await catalog.insertRow(metadata, [{ name: 'payload', value: 'generated' }]);
    assert.deepEqual(inserted.columns, ['id', 'payload']);
    assert.deepEqual(inserted.rows, [[1, 'generated']]);
    assert.equal(typeof inserted.rows[0][0], 'number');
    assert.deepEqual((await catalog.readOnlyQuery('SELECT id, payload FROM generated_record', [])).rows, [[1, 'generated']]);
  });
});

caseTest('inserts an omitted literal-default component of a composite SQLite key', DATABASE, async () => {
  await withSqliteCatalog('orm-catalog-literal-key-', "CREATE TABLE generated_record (tenant BIGINT NOT NULL, seq VARCHAR(30) NOT NULL DEFAULT 'generated', n BIGINT NOT NULL, PRIMARY KEY (tenant, seq))", async catalog => {
    const metadata = await catalog.describeTable({ namespace: 'main', name: 'generated_record' });
    assert.deepEqual(metadata.primaryKey, ['tenant', 'seq']);
    assert.equal(metadata.columns[1].defaultExpression, "'generated'");
    const inserted = await catalog.insertRow(metadata, [
      { name: 'tenant', value: 2 },
      { name: 'n', value: 50 },
    ]);
    assert.deepEqual(inserted.rows, [[2, 'generated', 50]]);
    assert.deepEqual((await catalog.readOnlyQuery('SELECT tenant, seq, n FROM generated_record', [])).rows, [[2, 'generated', 50]]);
  });
});

caseTest('inserts an omitted volatile expression-default SQLite key without reevaluating it', DATABASE, async () => {
  await withSqliteCatalog('orm-catalog-expression-key-', 'CREATE TABLE generated_record (seq TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), n INTEGER NOT NULL UNIQUE, label TEXT)', async catalog => {
    const metadata = await catalog.describeTable({ namespace: 'main', name: 'generated_record' });
    assert.deepEqual(metadata.primaryKey, ['seq']);
    assert.equal(metadata.columns[0].expressionDefault, true);
    const inserted = await catalog.insertRow(metadata, [
      { name: 'n', value: 1 },
      { name: 'label', value: null },
    ]);
    const [row] = inserted.rows;
    assert.ok(row);
    assert.match(row[0], /^[0-9a-f]{32}$/);
    assert.equal(typeof row[0], 'string');
    assert.equal(row[1], 1);
    assert.equal(row[2], null);
    assert.deepEqual((await catalog.readOnlyQuery('SELECT seq, n, label FROM generated_record', [])).rows, [row]);
  });
});

// Requirements: INT-118, PRT-79. The SQLite connection executes catalog work normally; only its COMMIT response is faulted.
caseTest('catalog/insert/indeterminate-commit-preserves-driver-cause', DATABASE, async () => {
  const failure = Object.assign(new Error('commit response lost by test driver'), { code: 'ERR_SQLITE_ERROR', errcode: 1 });
  const commits = [];
  await withSqliteCatalog(
    'orm-catalog-commit-failure-',
    'CREATE TABLE generated_record (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)',
    async catalog => {
      await rejectedIndeterminateInsert(catalog, failure);
      assert.deepEqual(commits, ['COMMIT'], 'only the COMMIT response was faulted');
      assert.equal(
        Number((await catalog.readOnlyQuery('SELECT COUNT(*) FROM generated_record', [])).rows[0][0]),
        0,
        'the next public read starts after SQLite cleanup ended the transaction',
      );
    },
    dsn => sqliteCatalogWithCommitFailure(dsn, failure, commits),
  );
});

// Requirements: INT-118, PRT-79.
caseTest('catalog/insert/indeterminate-commit-preserves-rollback-failure', DATABASE, async () => {
  const failure = Object.assign(new Error('commit response lost by test driver'), { code: 'ERR_SQLITE_ERROR', errcode: 1 });
  const rollbackFailure = Object.assign(new Error('rollback refused by test driver'), { code: 'ERR_SQLITE_ERROR', errcode: 1 });
  const commits = [];
  const rollbacks = [];
  await withSqliteCatalog(
    'orm-catalog-commit-rollback-failure-',
    'CREATE TABLE generated_record (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)',
    async catalog => {
      const error = await rejectedIndeterminateInsert(catalog, failure);
      assert.match(error.message, /rollback failed/);
      assert.ok(error.rollback instanceof OrmError);
      assert.equal(error.rollback.code, 'DRIVER');
      assert.strictEqual(error.rollback.cause, rollbackFailure);
      assert.deepEqual(commits, ['COMMIT'], 'only the COMMIT response was faulted');
      assert.deepEqual(rollbacks, ['ROLLBACK'], 'only one cleanup rollback was faulted after COMMIT');
    },
    dsn => sqliteCatalogWithCommitFailure(dsn, failure, commits, rollbackFailure, rollbacks),
  );
});
