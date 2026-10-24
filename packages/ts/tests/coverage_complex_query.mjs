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
