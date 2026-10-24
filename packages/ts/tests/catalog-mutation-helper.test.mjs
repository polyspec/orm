import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogConnection, CatalogRowSnapshot } from '../dist/catalog.js';
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
