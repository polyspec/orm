// The CPX-2 product search case: the eight ordered statements of contracts/fixtures/complex_query on the selected
// database, and the SQLite refusal before any statement.
// Requirements: CPX-2.
import assert from 'node:assert/strict';
import { connect } from '../dist/models/complex_query/models.js';
import { runCases } from './coverage_case.mjs';
import { assertSearchCase } from './complex-query-support.mjs';

const cases = {
  complex_query_product_search: async ({ driver, dsn }) => {
    if (typeof dsn !== 'string' || dsn === '') throw new Error(`missing seeded feature DSN for ${driver}`);
    const db = await connect(dsn);
    try {
      await assertSearchCase(assert, db, driver);
    } finally {
      await db.close();
    }
  },
};

await runCases('coverage_complex_query.mjs', cases, 60_000);
