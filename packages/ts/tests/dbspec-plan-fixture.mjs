import assert from 'node:assert/strict';
import { parsePlan } from '../dist/dbspec/index.js';
import { readPlanCases } from '../../../tests/dbspec/vectors.mts';

/** Parses the create-from-empty plan shared by apply verification tests. */
export function createFromEmptyPlans(root) {
  const selected = readPlanCases(new URL('tests/dbspec/plans.json', root).pathname).filter(c => c.id === 'create-from-empty');
  const plans = selected.map(c => {
    const parsed = parsePlan(c.plan.join('\n') + '\n');
    assert.deepEqual(parsed.diagnostics, [], `${c.id} diagnostics`);
    return parsed.plan;
  });
  assert.equal(plans.length, 1, 'plan-cases.json has no create-from-empty case');
  return plans;
}
