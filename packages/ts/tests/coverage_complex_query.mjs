import assert from 'node:assert/strict';
import { connect } from '../dist/models/complex_query/models.js';
import { runCases } from './coverage_case.mjs';
import { assertSearchResult, fixture, search } from './complex-query-support.mjs';

const cases = {
  complex_query_product_search: async ({ driver, dsn }) => {
    if (typeof dsn !== 'string' || dsn === '') throw new Error(`missing seeded feature DSN for ${driver}`);
    const db = await connect(dsn);
    try {
      const events = [];
      const unsubscribe = db.subscribe(event => events.push({ kind: event.kind, tables: [...event.tables] }));
      let page;
      let failure;
      try { page = await search(db, fixture.input); } catch (error) { failure = error; }
      unsubscribe();
      if (driver === 'sqlite') {
        assert.equal(failure?.code, fixture.expected_plan_steps.sqlite.error);
        assert.deepEqual(events, fixture.expected_events.sqlite);
        return;
      }
      if (failure !== undefined) throw failure;
      assertSearchResult(assert, page, events, driver);
    } finally {
      await db.close();
    }
  },
};

await runCases('coverage_complex_query.mjs', cases, 60_000);
