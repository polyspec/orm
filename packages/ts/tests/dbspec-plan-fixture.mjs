import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePlan } from '../dist/dbspec/index.js';

/** Parses the create-from-empty plan shared by apply verification tests. */
export function createFromEmptyPlans(root) {
  const cases = JSON.parse(readFileSync(new URL('tests/dbspec/plans.json', root), 'utf8'))
    .cases.filter(c => c.id === 'create-from-empty');
  const plans = cases.map(c => {
    const parsed = parsePlan(c.plan.join('\n') + '\n');
    assert.deepEqual(parsed.diagnostics, [], `${c.id} diagnostics`);
    return parsed.plan;
  });
  assert.equal(plans.length, 1, 'plans.json has no create-from-empty case');
  return plans;
}
