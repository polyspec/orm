import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CatalogConnection, CatalogRowSnapshot, connectCatalog } from '../dist/catalog.js';
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

test('locks, validates and returns the descriptor of an unchanged original row', async () => {
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

test('rejects a changed descriptor before applying MySQL safety', async () => {
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

test('inserts an omitted SQLite AUTOINCREMENT key and returns the stored row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orm-catalog-auto-key-'));
  const path = join(directory, 'catalog.sqlite');
  const database = new DatabaseSync(path);
  try {
    database.exec('CREATE TABLE generated_record (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)');
  } finally {
    database.close();
  }
  let catalog;
  try {
    catalog = await connectCatalog(`sqlite://${path}`);
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
  } finally {
    if (catalog !== undefined) await catalog.close();
    await rm(directory, { recursive: true, force: true });
  }
});
