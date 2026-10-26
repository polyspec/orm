import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { paginate, query } from '../dist/database.js';
import { Author, CompositeAccount, Engine } from '../dist/index.js';

caseTest('parent-slot-expansion/pads-composite-keys-and-renumbers', COMPUTE, async () => {
  const engine = new Engine(CompositeAccount.entity.model, 'sqlite');
  const request = {
    ir_version: 1,
    manifest_hash: CompositeAccount.entity.model.manifestHash,
    kind: 'all',
    entity: 'composite_account',
    n_params: 0,
    relations: [{
      rel: 'memberships',
      kind: 'many',
      keys: [
        { left: 'tenant_id', right: 'tenant_id' },
        { left: 'account_id', right: 'account_id' },
      ],
      query: { entity: 'composite_membership' },
    }],
  };
  const parents = [[10, 11], [20, 21], [30, 31]];
  let relationCall;
  const db = {
    md: undefined,
    driver: 'sqlite',
    requestHook: undefined,
    plan: async planned => ({ plan: engine.compile(planned), id: 'parent-slot-expansion' }),
    runStep: async (_ex, sql, step, _params, values) => {
      if (step.role === 'main') {
        const columns = step.assemble.columns;
        const rows = parents.map(([tenant, account]) => {
          const row = Array(columns.length).fill(null);
          for (const column of columns) {
            if (column.column === 'tenant_id') row[column.index] = tenant;
            if (column.column === 'account_id') row[column.index] = account;
          }
          return row;
        });
        return { rows };
      }
      relationCall = { sql, values };
      return { rows: [] };
    },
  };
  await query({ db, frame: undefined }, request, []);
  assert.ok(relationCall, 'the relation statement ran');
  assert.match(relationCall.sql, /IN \(\(\?, \?\), \(\?, \?\), \(\?, \?\), \(\?, \?\)\)/);
  assert.deepEqual(relationCall.values, [10, 11, 20, 21, 30, 31, 30, 31]);
});

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
