// The private effect query of TypeScript apply (docs/spec/plans.md "Apply"): a scripted MySQL connection that returns
// no row for an effect query. The cleanup errors are cases of the recipe tests/dbspec/apply-verification-errors.json.
//
// Usage: node --test packages/ts/tests/dbspec-apply-cleanup.mjs (after the build)
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { EFFECT_QUERIES, dbspecEffectHolds } from '../dist/dbspec/apply.js';

caseTest('apply/effect-row', COMPUTE, async () => {
  // A scripted MySQL connection whose effect query returns no row.
  const tables = EFFECT_QUERIES.mysql.table;
  const connection = {
    async query(q) {
      const sql = typeof q === 'string' ? q : q.sql;
      if (sql !== tables) throw new Error(`unexpected query ${sql}`);
      return [[], []];
    },
  };
  await assert.rejects(dbspecEffectHolds(connection, 'mysql', { kind: 'table', table: 'orders', name: '', present: true }), error => {
    assert.equal(error.message, `${tables} returned no row`);
    console.log(`  ${error.message}`);
    return true;
  });
});
