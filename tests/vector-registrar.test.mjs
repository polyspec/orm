import assert from 'node:assert/strict';
import test from 'node:test';
import { vectorRegistrar } from './vector-registrar.mjs';

test('binds the case name, deadline, and body and returns the registrar result', () => {
  const body = () => 'case body';
  const result = Symbol('registered');
  const calls = [];
  const vector = vectorRegistrar((...args) => { calls.push(args); return result; }, 5000);

  assert.equal(vector('plan/vector', body), result);
  assert.deepEqual(calls, [['plan/vector', 5000, body]]);
});
