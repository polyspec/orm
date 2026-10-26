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

// Requirements: INT-121.
caseTest('tablePage rejects prepared-column and in-scope descriptor changes', COMPUTE, async () => {
  const scenarios = [
    { after: descriptor, columns: [{ name: 'renamed' }] },
    { after: { ...descriptor, columns: [{ ...descriptor.columns[0], nullable: true }] }, columns: [{ name: 'id' }] },
  ];
  for (const scenario of scenarios) {
    let describeCount = 0;
    const session = {
      async describe() { describeCount++; return describeCount === 1 ? descriptor : scenario.after; },
      async collect() { return { columns: scenario.columns, rows: [] }; },
    };
    const catalog = new CatalogConnection('sqlite', {});
    catalog.read = async work => work(session);
    await assert.rejects(
      catalog.tablePage(descriptor.table, 1, 0),
      error => error instanceof OrmError && error.code === 'TABLE_PAGE_METADATA_CHANGED',
    );
  }
});
