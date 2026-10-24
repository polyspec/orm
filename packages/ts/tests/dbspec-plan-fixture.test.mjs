import assert from 'node:assert/strict';
import test from 'node:test';
import { createFromEmptyPlans } from './dbspec-plan-fixture.mjs';

test('loads the valid create-from-empty plan', () => {
  const plans = createFromEmptyPlans(new URL('../../../', import.meta.url));
  assert.equal(plans.length, 1);
  assert.ok(plans[0]);
});
