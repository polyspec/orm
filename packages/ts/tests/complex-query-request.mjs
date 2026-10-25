// Requirements: CPX-1.
import assert from 'node:assert/strict';
import { CORE, Engine } from '../dist/index.js';
import { Product } from '../dist/models/complex_query/models.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { buildSearch, fixture } from './complex-query-support.mjs';

caseTest('public product search compiles as three semijoins and rejects SQLite', COMPUTE, () => {
  const model = buildSearch(fixture.input);
  const core = model[CORE].clone();
  core.setLimit((fixture.input.page - 1) * fixture.input.per_page, fixture.input.per_page);
  const built = core.build('paginate');
  assert.equal(built.error, undefined);
  const request = built.finish();

  for (const driver of ['mysql', 'postgres']) {
    const plan = new Engine(Product.entity.model, driver).compile(request);
    assert.deepEqual(plan.steps.map(step => ({ role: step.role, tables: step.tables })), fixture.expected_plan_steps[driver]);
    for (const step of plan.steps.slice(0, 2)) {
      const sql = step.sql.toUpperCase();
      assert.equal((sql.match(/ IN \(SELECT /g) ?? []).length, 3, `${driver} root query uses three semijoins`);
      assert.equal(sql.includes(' JOIN '), false, `${driver} root query does not join filter rows`);
      assert.equal(sql.includes('GROUP BY'), false, `${driver} root query does not group`);
    }
  }
  assert.throws(() => new Engine(Product.entity.model, 'sqlite').compile(request), error => error?.code === fixture.expected_plan_steps.sqlite.error);
});
