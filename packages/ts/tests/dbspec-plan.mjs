// dbspec schema plans beside the shared vectors: plan steps reject an unknown dialect. The vectors of
// tests/dbspec/plan-cases.json run in dbspec-plan-cases.mjs, and the validation sections in dbspec-plan-<section>.mjs.
//
// Usage: node --test packages/ts/tests/dbspec-plan.mjs (after the build)
import assert from 'node:assert/strict';
import { planSteps } from '../dist/dbspec/index.js';
import { cases, plan, vector } from './plan_case.mjs';

// DBS-174: planSteps refuses a dialect that is none of mysql, postgres and sqlite with a TypeError that names it.
vector('plan steps reject an unknown dialect', () => {
  const p = plan(cases[0].plan);
  assert.throws(() => planSteps(null, p, 'oracle'), { name: 'TypeError', message: /oracle/ });
});
