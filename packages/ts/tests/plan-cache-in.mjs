// The plan cache key of an IN list (T169-3, the bucketing of packages/go/orm/canonical.go): an IN list pads to the next
// power of two by repeating its last value, and the parameters are renumbered by the walk of the request, so lengths
// 1 to 300 of one statement share at most ten keys, one per bucket.
import assert from 'node:assert/strict';
import { canonicalize } from '../dist/engine/canonical.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

function inRequest(n) {
  const ps = Array.from({ length: n }, (_, i) => i);
  const params = Array.from({ length: n }, (_, i) => `v${i}`);
  return { request: { ir_version: 1, manifest_hash: 'h', kind: 'all', entity: 'load_probe', where: { items: [{ pred: { column: 'seq', op: 'in', ps } }] }, n_params: n }, params };
}

// Requirements: CPX-4.
caseTest('IN lists of lengths 1 to 300 share at most ten plan cache keys', COMPUTE, () => {
  const keys = new Set();
  for (let n = 1; n <= 300; n++) {
    const { request, params } = inRequest(n);
    keys.add(JSON.stringify(canonicalize(request, params).request));
    assert.ok(keys.size <= 10, `length ${n}: ${keys.size} plan cache keys, want at most 10 (one per bucketed shape)`);
  }
});

// Requirements: CPX-4.
caseTest('an IN list pads to its bucket by repeating its last value and renumbers its parameters', COMPUTE, () => {
  const request = { ir_version: 1, manifest_hash: 'h', kind: 'all', entity: 'load_probe', where: { items: [{ pred: { column: 'seq', op: 'in', ps: [0, 1, 2] } }, { pred: { column: 'label', op: 'eq', p: 3 } }] }, n_params: 4 };
  const out = canonicalize(request, ['a', 'b', 'c', 'tail']);
  assert.deepEqual(out.request.where.items[0].pred.ps, [0, 1, 2, 3]);
  assert.equal(out.request.where.items[1].pred.p, 4);
  assert.deepEqual(out.params, ['a', 'b', 'c', 'c', 'tail']);
  assert.equal(out.request.n_params, 5);
  assert.equal(request.where.items[0].pred.ps.length, 3, 'the input request is not changed');
});

caseTest('a parameter index past the parameters is IR_INVALID', COMPUTE, () => {
  const request = { ir_version: 1, manifest_hash: 'h', kind: 'all', entity: 'load_probe', where: { items: [{ pred: { column: 'seq', op: 'in', ps: [7] } }] }, n_params: 1 };
  assert.throws(() => canonicalize(request, ['a']), (error) => error.code === 'IR_INVALID');
});
