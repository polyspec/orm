// dbspec schema plans (tests/dbspec/plans.json, docs/plans.md): every case
// parses its plan, emits it back unchanged, diffs it against its source and
// writes exactly the listed statements in every dialect; every invalid case
// reports exactly its plan diagnostics; every chain case orders its plans or
// reports exactly its chain diagnostics; every parse case reports exactly its
// diagnostics with rule, line, column and the message of a plan diagnostic.
//
// Usage: node --test clients/typescript/tests/dbspec-plan.mjs (after the build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { chainPlans, diffPlan, emitPlan, parseDbspec, parsePlan, planStatements } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const vectors = JSON.parse(readFileSync(new URL('tests/dbspec/plans.json', root), 'utf8'));
const TIMEOUT = 5000;
const DIALECTS = ['mysql', 'postgres', 'sqlite'];

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
function vector(name, body) {
  test(name, { timeout: TIMEOUT }, async () => {
    const started = performance.now();
    console.log(`start ${name}`);
    try {
      await body();
    } catch (error) {
      console.log(`result ${name}: FAIL after ${(performance.now() - started).toFixed(1)} ms`);
      throw error;
    }
    console.log(`result ${name}: PASS after ${(performance.now() - started).toFixed(1)} ms`);
  });
}

const text = lines => lines.join('\n') + '\n';

// source parses the source schema text of a case, or gives null for the empty schema.
function source(lines) {
  if (lines === null) return null;
  const result = parseDbspec(text(lines), {});
  assert.deepEqual(result.diagnostics, [], 'source diagnostics');
  return result.document;
}

function plan(lines) {
  const result = parsePlan(text(lines));
  assert.deepEqual(result.diagnostics, [], 'plan diagnostics');
  return result.plan;
}

assert.equal(vectors.version, 1, 'plans.json version');
assert(vectors.cases.length > 0 && vectors.invalid.length > 0 && vectors.chains.length > 0 && vectors.parse.length > 0, 'plans.json cases');

for (const c of vectors.cases) {
  vector(`plan ${c.id}`, () => {
    const from = source(c.source);
    const p = plan(c.plan);
    assert.equal(emitPlan(p), text(c.plan), 'emitPlan');
    const diff = diffPlan(from, p);
    assert.deepEqual(diff.diagnostics, []);
    assert.deepEqual(diff.changes.map(ch => [ch.kind, ch.table, ch.name]), c.changes);
    assert.deepEqual(Object.keys(c.statements).sort(), DIALECTS, 'dialects');
    for (const dialect of DIALECTS) {
      assert.deepEqual(planStatements(from, p, dialect), { statements: c.statements[dialect], diagnostics: [] }, dialect);
    }
  });
}

for (const c of vectors.invalid) {
  vector(`plan invalid ${c.id}`, () => {
    const from = source(c.source);
    let { plan: p, diagnostics } = parsePlan(text(c.plan));
    if (p !== null) diagnostics = diffPlan(from, p).diagnostics;
    for (const d of diagnostics) assert.equal(d.rule, 'plan', d.message);
    assert.deepEqual(diagnostics.map(d => d.message), c.errors);
  });
}

for (const c of vectors.chains) {
  vector(`plan chain ${c.id}`, () => {
    const result = chainPlans(c.plans.map(plan));
    for (const d of result.diagnostics) assert.equal(d.rule, 'chain', d.message);
    assert.deepEqual(result.diagnostics.map(d => d.message), c.errors ?? []);
    assert.deepEqual(result.plans?.map(p => p.name) ?? null, c.order ?? null);
  });
}

for (const c of vectors.parse) {
  vector(`plan parse ${c.id}`, () => {
    const { diagnostics } = parsePlan(text(c.plan));
    // plan diagnostic은 message까지, target diagnostic은 rule, 줄, 칸까지 비교한다.
    assert.deepEqual(diagnostics.map(d => [d.rule, d.line, d.column, d.rule === 'plan' ? d.message : null]), c.errors);
  });
}

vector('plan statements reject an unknown dialect', () => {
  const p = plan(vectors.cases[0].plan);
  assert.throws(() => planStatements(null, p, 'oracle'), { name: 'TypeError', message: /oracle/ });
});
