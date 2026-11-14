import assert from 'node:assert/strict';
import { caseTest } from '../../../../tests/testcase.mts';
import { createFromEmptyPlans } from './dbspec-plan-fixture.mjs';

caseTest('loads the valid create-from-empty plan', () => {
  const plans = createFromEmptyPlans(new URL('../../../', import.meta.url));
  assert.equal(plans.length, 1);
  assert.ok(plans[0]);
});
