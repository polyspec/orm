import assert from 'node:assert/strict';
import { CORE, Engine } from '../dist/index.js';
import { Product } from '../dist/models/complex_query/models.js';
import { buildSearch, fixture } from './complex-query-support.mjs';

const model = buildSearch(fixture.input);
const core = model[CORE].clone();
core.setLimit((fixture.input.page - 1) * fixture.input.per_page, fixture.input.per_page);
const built = core.build('paginate');
assert.equal(built.error, undefined);
const request = built.finish();

for (const driver of ['mysql', 'postgres']) {
  const plan = new Engine(Product.entity.model, driver).compile(request);
  assert.deepEqual(plan.steps.map(step => ({ role: step.role, tables: step.tables })), fixture.expected_plan_steps[driver]);
}
assert.throws(() => new Engine(Product.entity.model, 'sqlite').compile(request), error => error?.code === fixture.expected_plan_steps.sqlite.error);
console.log('complex-query-request: mysql/postgres valid; sqlite rejected before execution');
