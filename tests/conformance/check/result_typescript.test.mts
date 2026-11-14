import assert from 'node:assert/strict';
import { caseTest } from '../../testcase.mts';
import { parse } from '@polyspec/ordered-json';
import { StyledValue } from '../../../legacy/packages/ts/dist/index.js';
import { executeVector, resultValue } from '../../../legacy/packages/ts/testing/conformance/result_typescript.mts';

// Deadline of each case 1 s: the case writes a few result values in memory and compares them.
// COD-16 and COD-20: an ordered-json number keeps its exact text, and SQL NULL is its own styled state.
// Requirement: COD-16, COD-20.
caseTest('ordered-json numbers and styled states remain exact in result output', () => {
  const result = resultValue({
    exact: parse('9007199254740993'),
    exactBigInt: 9007199254740993n,
    styled: StyledValue.value(parse('{"n":9007199254740993}')),
    sqlNull: StyledValue.sqlNull(),
  });
  assert.equal(JSON.stringify(result), '{"exact":9007199254740993,"exactBigInt":9007199254740993,"styled":{"kind":"value","value":{"n":9007199254740993}},"sqlNull":{"kind":"sql-null"}}');
});

// COD-16: a TypeScript toJSON fails with CODEC_ENCODE when JavaScript would reorder a member key.
caseTest('a member key that JavaScript reorders reports an error', () => {
  assert.throws(() => resultValue(parse('{"1":1,"a":2}')), { code: 'CODEC_ENCODE' });
});

// COD-21: an undefined member or a non-finite number fails with CODEC_ENCODE and is never written as null.
caseTest('a result never drops an undefined field or writes a non-finite number as null', () => {
  assert.throws(() => resultValue({ missing: undefined }), /undefined conformance result/);
  assert.throws(() => resultValue([Number.NaN]), /non-finite conformance result/);
  assert.throws(() => resultValue(StyledValue.value({ missing: undefined })), { code: 'CODEC_ENCODE' });
  const sparse: unknown[] = [];
  sparse[1] = 1;
  assert.throws(() => resultValue(sparse), /sparse conformance result/);
  assert.throws(() => resultValue({ [Symbol('hidden')]: 1 }), /symbol-keyed conformance result/);
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  assert.throws(() => resultValue(hidden), /non-enumerable conformance result/);
  assert.throws(() => resultValue(new Date('2026-01-01T00:00:00Z')), /unsupported conformance result/);
});

// COD-46: the TypeScript conformance runner preserves a vector's original error and uses the supplied transaction for writes.
caseTest('unexpected vector errors preserve their cause and write vectors use a transaction', async () => {
  const cause = new Error('invalid row');
  await assert.rejects(executeVector('invalid', async () => { throw cause; }), (error: unknown) => {
    assert.ok(error instanceof Error, String(error));
    assert.match(error.message, /invalid/);
    assert.equal(error.cause, cause);
    return true;
  });
  let transactionCalled = false;
  const value = await executeVector('write', async () => 7, async (task: () => Promise<unknown>) => {
    transactionCalled = true;
    return task();
  });
  assert.equal(transactionCalled, true);
  assert.equal(value, 7);
});
