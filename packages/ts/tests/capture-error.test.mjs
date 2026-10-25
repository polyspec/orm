import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { captureError } from './capture-error.mjs';

caseTest('returns null on success and the accepted error on failure', COMPUTE, async () => {
  const failure = new Error('expected failure');
  assert.equal(await captureError(async () => {}), null);
  assert.equal(await captureError(async () => { throw failure; }), failure);
  assert.equal(await captureError(async () => {}, { success: undefined }), undefined);
});

caseTest('rethrows a failure rejected by the acceptance predicate', COMPUTE, async () => {
  const failure = new Error('unexpected failure');
  await assert.rejects(captureError(async () => { throw failure; }, { accepts: error => error instanceof TypeError }), error => error === failure);
});
