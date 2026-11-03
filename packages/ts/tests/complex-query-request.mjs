import assert from 'node:assert/strict';
import { Product, ProductReview, SCHEMA, connect } from '../dist/models/complex_query/models.js';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';

// Requirements: DSL-159.
caseTest('getPagePlanSteps gives the steps of the plan that getsPage runs', DATABASE, async ({ step }) => {
  await withCaseDatabase('sqlite', step, async database => {
    const db = await connect(database.dsn);
    try {
      await db.utils().schema().install(SCHEMA);
      const query = () => new Product().connect(db).relations(new ProductReview().matchSeqWithProductSeq().aliasReviews()).serviceSeq(7).orderBySeqDesc();
      const steps = await query().getPagePlanSteps(2, 20);
      assert.deepEqual(steps.map(s => ({ role: s.role, tables: s.tables })), [
        { role: 'main', tables: ['product'] },
        { role: 'count', tables: ['product'] },
        { role: 'relation', tables: ['product_review'] },
      ]);
      // The steps are the statements that getsPage sends.
      const events = [];
      const unsubscribe = db.subscribe(event => events.push(event.sql));
      await query().getsPage(2, 20);
      unsubscribe();
      assert.deepEqual(events, [steps[0].sql, steps[1].sql]);
      const config = error => error?.code === 'CONFIG';
      await assert.rejects(query().getPagePlanSteps(0, 20), config);
      await assert.rejects(query().getPagePlanSteps(1, 0), config);
      await assert.rejects(query().limit(0, 1).getPagePlanSteps(1, 20), config);
      await assert.rejects(new Product().getPagePlanSteps(1, 20), config);
      await assert.rejects(new Product().connect(db).fulltextBooleanNameWithShortDescriptionWithContent('alpha').getPagePlanSteps(1, 20), error => error?.code === 'OPERATOR_NOT_ALLOWED');
    } finally {
      await db.close();
    }
  });
});
