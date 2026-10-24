import assert from 'node:assert/strict';
import { caseTest } from '../../../tests/testcase.mts';
import { createCaseAssertions, createFailureCheck } from './check-state.mjs';

caseTest('reports only failed checks with the current case and increments once', 1000, () => {
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

caseTest('captures rejected database cases and preserves undefined for successful cases', 1000, async () => {
  const { raised } = createCaseAssertions(() => 'case', () => {});
  const failure = new Error('database case failed');
  assert.equal(await raised(async () => {}), undefined);
  assert.equal(await raised(async () => { throw failure; }), failure);
});
