// The plan cache key of an IN list (T169-3, the bucketing of packages/go/orm/canonical.go): an IN list pads to the next
// power of two by repeating its last value, and the parameters are renumbered by the walk of the request, so lengths
// 1 to 300 of one statement share at most ten keys, one per bucket.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Engine, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { canonicalize } from '../dist/engine/canonical.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

const schemaText = await readFile(new URL('../../../contracts/fixtures/identity_load.dbs', import.meta.url), 'utf8');
const parsed = parseDbspec(schemaText, {});
assert.deepEqual(parsed.diagnostics, []);
const { manifest } = dbspecManifest([parsed.document]);
const model = registerModel(manifest.manifestText, manifest.manifestHash);

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

// Requirements: T236.
caseTest('root pages share one plan shape and bind offset then count', COMPUTE, () => {
  const keys = new Set();
  for (let page = 0; page < 300; page++) {
    const request = { ir_version: 1, manifest_hash: 'h', kind: 'all', entity: 'load_probe', where: { items: [{ pred: { column: 'seq', op: 'eq', p: 0 } }] }, limit: { offset: page * 20, count: 20 }, n_params: 1 };
    const out = canonicalize(request, ['where']);
    keys.add(JSON.stringify(out.request));
    assert.deepEqual(out.request.limit, { offset_p: 1, count_p: 2 });
    assert.deepEqual(out.params, ['where', page * 20, 20]);
  }
  assert.equal(keys.size, 1, '300 pages should share one plan shape');
});

// Requirements: T236.
caseTest('root page placeholders retain dialect SQL and bind order', COMPUTE, () => {
  const request = {
    ir_version: 1, manifest_hash: manifest.manifestHash, kind: 'all', entity: 'load_probe', n_params: 3,
    where: { items: [{ pred: { column: 'seq', op: 'eq', p: 0 } }] },
    limit: { offset_p: 1, count_p: 2 },
  };
  for (const dialect of ['mysql', 'postgres', 'sqlite']) {
    const plan = new Engine(model, dialect).compile(request);
    const step = plan.steps[0];
    const expectedParams = dialect === 'mysql' ? [0, 1, 2] : [0, 2, 1];
    assert.deepEqual(step.bind_slots.map(slot => slot.param), expectedParams, `${dialect} parameter order`);
    assert.match(step.sql, dialect === 'mysql' ? /LIMIT \?, \?$/ : /LIMIT \$2 OFFSET \$3$|LIMIT \? OFFSET \?$/);
  }
});

// Requirements: T236.
caseTest('composite request parameters follow the specified recursive walk', COMPUTE, () => {
  const pred = p => ({ items: [{ pred: { column: 'seq', op: 'eq', p } }] });
  const request = {
    ir_version: 1, manifest_hash: 'h', kind: 'all', entity: 'root', n_params: 18,
    columns: {
      fn: {
        z_fn: { column: 'seq', fn: { name: 'year', ps: [0] } },
        a_fn: { column: 'seq', fn: { name: 'year', ps: [1] } },
      },
      sub: {
        z_sub: { column: 'seq', query: { entity: 'inner', where: pred(2) } },
        a_sub: { column: 'seq', query: { entity: 'inner', where: pred(3) } },
      },
    },
    on: pred(4), where: pred(5),
    joins: [{ rel: 'j', kind: 'inner', query: { entity: 'joined', on: pred(6), where: pred(7) } }],
    relations: [
      { rel: 'r1', query: { entity: 'related', where: pred(8), if_parent: { column: 'seq', p: 9 } } },
      { rel: 'r2', query: { entity: 'related', where: pred(10) } },
    ],
    order: [{ column: 'seq', fn: { name: 'year', ps: [11] } }],
    limit: { offset: 0, count: 20 }, if_parent: { column: 'seq', p: 12 },
    set: [{ column: 'seq', p: 13 }], on_duplicate: [{ column: 'seq', p: 14 }],
    rows: [[15]], optimistic: { column: 'seq', p: 16 },
  };
  const result = canonicalize(request, Array.from({ length: 18 }, (_, i) => `v${i}`));
  assert.deepEqual(result.params, ['v1', 'v0', 'v3', 'v2', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11', 0, 20, 'v12', 'v13', 'v14', 'v15', 'v16', 'v17']);
  assert.deepEqual(result.request.limit, { offset_p: 12, count_p: 13 });
  assert.equal(result.request.if_parent.p, 14);
  assert.equal(result.request.set[0].p, 15);
  assert.equal(result.request.on_duplicate[0].p, 16);
  assert.deepEqual(result.request.rows, [[17]]);
  assert.equal(result.request.optimistic.p, 18);
});

// Requirements: T236.
caseTest('page parameter values and limit shape are validated before planning', COMPUTE, () => {
  const canonical = (limit, params) => canonicalize({ ir_version: 1, manifest_hash: 'h', kind: 'all', entity: 'load_probe', limit, n_params: params.length }, params);
  for (const value of [null, false, '1', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => canonical({ offset_p: 0, count_p: 1 }, [value, 2]), error => error.code === 'CODEC_ENCODE', `invalid offset ${String(value)}`);
  }
  assert.throws(() => canonical({ offset_p: 0, count_p: 1 }, [-1, 2]), error => error.code === 'IR_INVALID');
  assert.throws(() => canonical({ offset_p: 0, count_p: 1 }, [0, 0]), error => error.code === 'IR_INVALID');
  assert.throws(() => canonical({ offset: 0, count: 2, offset_p: 0, count_p: 1 }, [0, 2]), error => error.code === 'IR_INVALID');
  assert.throws(() => canonical({ offset: 0 }, []), error => error.code === 'IR_INVALID');
  assert.throws(() => canonical({ offset_p: 0, count_p: 1 }, [0]), error => error.code === 'IR_INVALID');
});
