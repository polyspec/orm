// dbspec schema plans beside the shared vectors: plan steps reject an unknown dialect. The vectors of
// tests/dbspec/plans.json run in dbspec-plan-<section>.mjs.
//
// Usage: node --test packages/ts/tests/dbspec-plan.mjs (after the build)
import assert from 'node:assert/strict';
import { planSteps } from '../dist/dbspec/index.js';
import { plan, vector, vectors } from './plan_case.mjs';

vector('plan steps reject an unknown dialect', () => {
  const p = plan(vectors.cases[0].plan);
  assert.throws(() => planSteps(null, p, 'oracle'), { name: 'TypeError', message: /oracle/ });
});
