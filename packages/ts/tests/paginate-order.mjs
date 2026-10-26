import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { paginate } from '../dist/database.js';
import { Author } from '../dist/index.js';

caseTest('paginate/internal-plan-order-and-dispatch', COMPUTE, async () => {
  const request = {
    ir_version: 1,
    manifest_hash: Author.entity.model.manifestHash,
    kind: 'paginate',
    entity: 'author',
    n_params: 0,
    relations: [{ rel: 'users', kind: 'one', keys: [{ left: 'user_seq', right: 'seq' }], query: { entity: 'user' } }],
  };
  const plan = new Engine(Author.entity.model, 'sqlite').compile(request);
  assert.deepEqual(plan.steps.map(step => step.role), ['main', 'count', 'relation']);
  const calls = [];
  const db = {
    md: undefined,
    driver: 'sqlite',
    requestHook: undefined,
    plan: async () => ({ plan, id: 'page' }),
    runStep: async (_ex, _sql, step) => {
      calls.push(step.role);
      if (step.role === 'main') {
        const columns = step.assemble.columns;
        return { rows: [columns.map(column => column.column === 'seq' ? 1 : column.column === 'user_seq' ? 7 : null)] };
      }
      if (step.role === 'count') return { rows: [[11]] };
      return { rows: [step.assemble.columns.map(column => column.column === 'seq' ? 7 : null)] };
    },
  };
  const out = await paginate({ db, frame: undefined }, request, []);
  assert.deepEqual(calls, ['main', 'count', 'relation']);
  assert.equal(out.total, 11);
  assert.equal(out.result.main.length, 1);
  assert.equal(out.result.steps.get(2).data.length, 1);
});
