import assert from 'node:assert/strict';
import test from 'node:test';
import { exactKeys } from './assertions.mjs';

test('exactKeys accepts only objects with the expected key set', () => {
  exactKeys({ second: 2, first: 1 }, ['first', 'second'], 'valid');
  assert.throws(() => exactKeys([], [], 'array'), { name: 'AssertionError', message: /array is an object/ });
  assert.throws(() => exactKeys(null, [], 'null'), { name: 'AssertionError', message: /null is an object/ });
  assert.throws(() => exactKeys({ first: 1 }, ['first', 'second'], 'missing'), {
    name: 'AssertionError',
    message: /missing has exactly the keys/,
  });
  assert.throws(() => exactKeys({ first: 1, extra: true }, ['first'], 'extra'), {
    name: 'AssertionError',
    message: /extra has exactly the keys/,
  });
});
