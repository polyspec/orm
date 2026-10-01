// Tests the comparison of client outputs (tests/dbspec/compare/check.mjs).
//
// Usage: node --test tests/dbspec/compare/check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { compare } from './compare.mjs';

const go = 'canonical/a\n| dbspec 1 shop\n| \ninvalid/b\n! header 1 14\nstress\n= unchanged\n';

test('equal outputs agree', () => {
  assert.equal(compare([{ name: 'go 1', output: go }, { name: 'rust 1', output: go }]), null);
});

test('a different diagnostic names its case and both lines', () => {
  const rust = go.replace('! header 1 14', '! header 1 15');
  assert.deepEqual(compare([{ name: 'go 1', output: go }, { name: 'rust 1', output: rust }]), {
    reference: 'go 1',
    other: 'rust 1',
    case: 'invalid/b',
    line: 5,
    expected: '! header 1 14',
    actual: '! header 1 15',
  });
});

test('a different plan message names its plan case', () => {
  const plans = 'plans/parse/name-too-long\n! plan 1 1 the first line is exactly `dbplan 1 <name>`\n';
  const rust = plans.replace('exactly', 'not');
  assert.deepEqual(compare([{ name: 'go 1', output: plans }, { name: 'rust 1', output: rust }]), {
    reference: 'go 1',
    other: 'rust 1',
    case: 'plans/parse/name-too-long',
    line: 2,
    expected: '! plan 1 1 the first line is exactly `dbplan 1 <name>`',
    actual: '! plan 1 1 the first line is not `dbplan 1 <name>`',
  });
});

test('a shorter output differs at its end', () => {
  const php = go.slice(0, go.indexOf('stress'));
  const difference = compare([{ name: 'go 1', output: go }, { name: 'php 1', output: php }]);
  assert.equal(difference.case, 'stress');
  assert.equal(difference.actual, '(end of output)');
});

test('an empty output is a difference, not an agreement', () => {
  assert.throws(() => compare([{ name: 'go 1', output: '' }]), /go 1 printed no case/);
});
