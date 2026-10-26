import assert from 'node:assert/strict';
import { caseTest } from '../../testcase.mts';
import { derivedInteger, executeVector } from '../../../packages/ts/testing/conformance/result_typescript.mts';

// COD-45: the TypeScript conformance runner accepts only exactly representable derived integers in its JSON result.
caseTest('derived integer conversion preserves the exact numeric value', 1000, () => {
  assert.equal(derivedInteger(2), 2);
  assert.equal(derivedInteger('2'), 2);
  assert.equal(derivedInteger(2n), 2);
  assert.equal(derivedInteger(9007199254740992n), 9007199254740992);
  assert.equal(derivedInteger('9007199254740992'), 9007199254740992);
  for (const value of [null, true, '', 'bad', '2.0', '2.5', 2.5, Number.NaN, Number.POSITIVE_INFINITY, '9007199254740993', 9007199254740993n, 1n << 63n]) {
    assert.throws(() => derivedInteger(value), /invalid derived integer/);
  }
});

// COD-46: the TypeScript conformance runner preserves a vector's original error and uses the supplied transaction for writes.
caseTest('unexpected vector errors preserve their cause and write vectors use a transaction', 1000, async () => {
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
