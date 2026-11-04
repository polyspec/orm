import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { CatalogConnection } from '../dist/catalog.js';
import { OrmError } from '../dist/runtime_error.js';

const descriptor = {
  table: { namespace: 'main', name: 'page_probe' },
  kind: 'table',
  columns: [{ name: 'id', nativeType: 'INTEGER', nullable: false, generated: false, automaticKey: false, defaultExpression: null, expressionDefault: false, checkPrecision: null }],
  primaryKey: ['id'],
  reliableRowIdentity: true,
};

// Requirements: INT-121. What no server can answer: a statement names its columns in the select list, and a server answers
// with those names.
caseTest('tablePage refuses prepared columns that differ from the descriptor', COMPUTE, async () => {
  const session = {
    async describe() { return descriptor; },
    async collect() { return { columns: [{ name: 'renamed' }], rows: [] }; },
  };
  const catalog = new CatalogConnection('sqlite', {});
  catalog.read = async work => work(session);
  await assert.rejects(
    catalog.tablePage(descriptor.table, 1, 0),
    error => error instanceof OrmError && error.code === 'TABLE_PAGE_METADATA_CHANGED',
  );
});
