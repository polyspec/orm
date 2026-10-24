import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from './join.mjs';

test('joins vector lines with the declared line endings without changing input', () => {
  const lines = ['alpha', 'beta', 'gamma'];
  const original = [...lines];

  assert.equal(join(lines, false), 'alpha\nbeta\ngamma\n');
  assert.equal(join(lines, true), 'alpha\r\nbeta\r\ngamma\r\n');
  assert.equal(join(lines, false, true), 'alpha\r\nbeta\ngamma');
  assert.equal(join([], false), '\n');
  assert.equal(join([], true), '\r\n');
  assert.equal(join([], false, true), '');
  assert.deepEqual(lines, original);
});
