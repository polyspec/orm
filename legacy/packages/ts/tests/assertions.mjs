import assert from 'node:assert/strict';

/** Asserts that `value` is an object with exactly the keys `keys`. */
export function exactKeys(value, keys, where) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${where} is an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${where} has exactly the keys ${keys.join(', ')}`);
}
