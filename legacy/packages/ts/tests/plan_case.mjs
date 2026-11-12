// plan_case.mjs holds the helpers of the dbspec plan cases (docs/spec/plans.md) for the TypeScript client. The cases are the
// recipe tests/dbspec/plan-cases.json, run by dbspec-plan-cases.mjs through recipe.mjs; cases reads them with their physical
// records for the physical tests and the apply tools. The validation sections are the recipes tests/dbspec/plan-*.json.
import { caseTest } from '../../../../tests/testcase.mts';
import { vectorRegistrar } from '../../../../tests/vector-registrar.mjs';
import { readPlanCases } from '../../../../tests/dbspec/vectors.mts';
import assert from 'node:assert/strict';
import { parseDbspec, parsePlan } from '../dist/dbspec/index.js';

export const root = new URL('../../../', import.meta.url);
// TIMEOUT is the deadline (ms) of one case. One plan vector parses one plan in memory and builds its steps.
const TIMEOUT = 5000;

// cases are the plan cases of plan-cases.json with their physical records (readPlanCases).
export const cases = readPlanCases(new URL('tests/dbspec/plan-cases.json', root).pathname);

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
export const vector = vectorRegistrar(caseTest, TIMEOUT);

export const text = lines => lines.join('\n') + '\n';

// source parses the source schema text of a case, or gives null for the empty schema.
export function source(lines) {
  if (lines === null) return null;
  const result = parseDbspec(text(lines), {});
  assert.deepEqual(result.diagnostics, [], 'source diagnostics');
  return result.document;
}

export function plan(lines) {
  const result = parsePlan(text(lines));
  assert.deepEqual(result.diagnostics, [], 'plan diagnostics');
  return result.plan;
}

assert(cases.length > 0, 'plan-cases.json cases');
