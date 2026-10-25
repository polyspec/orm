import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { vectorRegistrar } from '../../tests/vector-registrar.mjs';

caseTest('binds the case name, deadline, and body and returns the registrar result', COMPUTE, () => {
  const body = () => 'case body';
  const result = Symbol('registered');
  const calls = [];
  const vector = vectorRegistrar((...args) => { calls.push(args); return result; }, 5000);

  assert.equal(vector('plan/vector', body), result);
  assert.deepEqual(calls, [['plan/vector', 5000, body]]);
});
