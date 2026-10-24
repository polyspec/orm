import assert from 'node:assert/strict';
import test from 'node:test';
import { captureError } from './capture-error.mjs';

test('returns null on success and the accepted error on failure', async () => {
  const failure = new Error('expected failure');
  assert.equal(await captureError(async () => {}), null);
  assert.equal(await captureError(async () => { throw failure; }), failure);
});

test('rethrows a failure rejected by the acceptance predicate', async () => {
  const failure = new Error('unexpected failure');
  await assert.rejects(captureError(async () => { throw failure; }, error => error instanceof TypeError), error => error === failure);
});
