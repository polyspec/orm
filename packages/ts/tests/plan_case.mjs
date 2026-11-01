// plan_case.mjs holds the dbspec schema plan vectors of the cases section of tests/dbspec/plans.json (docs/spec/plans.md) for
// the TypeScript client: the helpers and planCases, which dbspec-plan-cases.mjs calls. The other sections are recipes
// (tests/dbspec/plan-*.json), run by dbspec-plan-<section>.mjs through recipe.mjs.
import { caseTest } from '../../../tests/testcase.mts';
import { vectorRegistrar } from '../../../tests/vector-registrar.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffPlan, effectText, emitPlan, parseDbspec, parsePlan, planSteps } from '../dist/dbspec/index.js';

export const root = new URL('../../../', import.meta.url);
export const vectors = JSON.parse(readFileSync(new URL('tests/dbspec/plans.json', root), 'utf8'));
// TIMEOUT is the deadline (ms) of one case. One plan vector parses one plan in memory and builds its steps.
const TIMEOUT = 5000;
const DIALECTS = ['mysql', 'postgres', 'sqlite'];

// stepFields is the plans.json object of a step (docs/spec/plans.md "Steps").
function stepFields(s) {
  const out = { statement: s.statement, effect: effectText(s.effect) };
  if (s.rollback !== '') out.rollback = s.rollback;
  else if (s.irreversible !== '') out.irreversible = s.irreversible;
  if (s.restore !== '') out.restore = s.restore;
  if (s.rollbackRestore !== '') out.rollback_restore = s.rollbackRestore;
  if (s.restore !== '' || s.rollbackRestore !== '') out.restore_if = effectText(s.restoreIf);
  if (s.nullChecks.length > 0) out.null_checks = s.nullChecks.map(c => [c.table, c.column, c.default]);
  if (s.finalize) out.finalize = true;
  return out;
}

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

assert.equal(vectors.version, 1, 'plans.json version');
assert(vectors.cases.length > 0, 'plans.json cases');

// planCases registers each case of its section as a top-level test named by its id.
export function planCases() {
  for (const c of vectors.cases) {
    vector(c.id, () => {
      const from = source(c.source);
      const p = plan(c.plan);
      assert.equal(emitPlan(p), text(c.plan), 'emitPlan');
      const diff = diffPlan(from, p);
      assert.deepEqual(diff.diagnostics, []);
      assert.deepEqual(diff.changes.map(ch => [ch.kind, ch.table, ch.name]), c.changes);
      assert.deepEqual(Object.keys(c.steps).sort(), DIALECTS, 'dialects');
      for (const dialect of DIALECTS) {
        const result = planSteps(from, p, dialect);
        assert.deepEqual(result.diagnostics, [], dialect);
        assert.deepEqual(result.steps.map(stepFields), c.steps[dialect], dialect);
      }
    });
  }
}
