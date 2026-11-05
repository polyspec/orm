import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { query } from '../dist/database.js';
import { CompositeAccount, Engine } from '../dist/index.js';

// Requirements: DSL-153.
caseTest('parent-slot-expansion/preserves-bare-dollar', COMPUTE, async () => {
  const engine = new Engine(CompositeAccount.entity.model, 'postgres');
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
  let relationCall;
  const db = {
    md: undefined,
    driver: 'postgres',
    requestHook: undefined,
    plan: async planned => {
      const plan = engine.compile(planned);
      plan.steps.find(step => step.role === 'relation').sql = "SELECT '$' AS sign, id FROM items WHERE key IN ($1)";
      return { plan, id: 'parent-slot-expansion' };
    },
    runStep: async (_ex, _sql, step, _params, values) => {
      if (step.role === 'main') {
        const columns = step.assemble.columns;
        return { rows: [columns.map(column => column.column === 'tenant_id' ? 10 : column.column === 'account_id' ? 11 : null)] };
      }
      relationCall = { sql: _sql, values };
      return { rows: [] };
    },
  };

  await query({ db, frame: undefined }, request, []);
  assert.deepEqual(relationCall, {
    sql: "SELECT '$' AS sign, id FROM items WHERE key IN ($1, $2)",
    values: [10, 11],
  });
});
