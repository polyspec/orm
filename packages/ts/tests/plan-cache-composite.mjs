// The plan cache key of a composite request (T169-3, the walk of packages/go/orm/canonical.go): the column functions and
// the subqueries of the columns in the order of their names, then on, where, the joins, the relations, the order, the
// limit offset and count, the parent condition, set, on duplicate, the rows and the optimistic column. The shared vector
// is contracts/fixtures/plan_cache_composite.json.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalize } from '../dist/engine/canonical.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

const vector = JSON.parse(await readFile(new URL('../../../contracts/fixtures/plan_cache_composite.json', import.meta.url), 'utf8'));

// Requirements: CPX-4.
caseTest('plan_cache_composite_parameter_order', COMPUTE, () => {
  const { request, params } = canonicalize(structuredClone(vector.request), structuredClone(vector.params));
  assert.deepEqual(params, vector.canonical.params);
  assert.equal(request.n_params, vector.canonical.n_params);
  assert.deepEqual(request.limit, { offset_p: vector.canonical.limit.offset_p, count_p: vector.canonical.limit.count_p });
  assert.equal(request.if_parent.p, vector.canonical.if_parent_p);
  assert.deepEqual(request.set.map(a => a.p), vector.canonical.set_p);
  assert.deepEqual(request.on_duplicate.map(a => a.p), vector.canonical.on_duplicate_p);
  assert.deepEqual(request.rows, vector.canonical.rows);
  assert.equal(request.optimistic.p, vector.canonical.optimistic_p);
});

// Requirements: CPX-4.
caseTest('plan_cache_predicate_fn_parameter_order', COMPUTE, () => {
  const vec = vector.predicate_fn_param;
  const { request, params } = canonicalize(structuredClone(vec.request), structuredClone(vec.params));
  assert.deepEqual(params, vec.canonical.params);
  assert.equal(request.n_params, vec.canonical.n_params);
  const pred = request.where.items[0].pred;
  assert.equal(pred.p, vec.canonical.where_p);
  assert.deepEqual(pred.fn.ps, vec.canonical.fn_ps);
});
