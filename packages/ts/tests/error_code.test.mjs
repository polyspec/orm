import assert from 'node:assert/strict';
import test from 'node:test';
import { codeOf } from './error_code.mjs';

class OrmError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

test('returns null, an ORM code, or the rejected value string', async () => {
  assert.equal(await codeOf(Promise.resolve(), OrmError), null);
  assert.equal(await codeOf(Promise.reject(new OrmError('CONFIG')), OrmError), 'CONFIG');
  const other = new Error('other failure');
  assert.equal(await codeOf(Promise.reject(other), OrmError), String(other));
  assert.equal(await codeOf(Promise.reject('non-error rejection'), OrmError), 'non-error rejection');
});
