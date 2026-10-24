import assert from 'node:assert/strict';
import test from 'node:test';
import { createFailureCheck } from './check-state.mjs';

test('reports only failed checks with the current case and increments once', () => {
  let current = 'first';
  let failures = 0;
  const reports = [];
  const check = createFailureCheck(() => current, () => { failures++; }, message => reports.push(message));
  check(true, 'passed');
  assert.equal(failures, 0);
  assert.deepEqual(reports, []);
  check(false, 'expected detail');
  assert.equal(failures, 1);
  assert.deepEqual(reports, ['FAIL first: expected detail']);
  current = 'second';
  check(false, 'another detail');
  assert.equal(failures, 2);
  assert.deepEqual(reports, ['FAIL first: expected detail', 'FAIL second: another detail']);
});
