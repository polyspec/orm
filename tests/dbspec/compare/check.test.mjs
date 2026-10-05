// Tests the comparison of client outputs (tests/dbspec/compare/check.mjs).
//
// Usage: node --test tests/dbspec/compare/check.test.mjs
import { caseTest, COMPUTE } from '../../testcase.mjs';
import assert from 'node:assert/strict';
import { compare } from './compare.mjs';

const go = 'canonical/a\n| dbspec 1 shop\n| \ninvalid/b\n! header 1 14\nstress\n= unchanged\n';

caseTest('equal outputs agree', COMPUTE, () => {
  assert.equal(compare([{ name: 'go 1', output: go }, { name: 'rust 1', output: go }]), null);
});

caseTest('a different diagnostic names its case and both lines', COMPUTE, () => {
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

caseTest('a different plan message names its plan case', COMPUTE, () => {
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

caseTest('a shorter output differs at its end', COMPUTE, () => {
  const php = go.slice(0, go.indexOf('stress'));
  const difference = compare([{ name: 'go 1', output: go }, { name: 'php 1', output: php }]);
  assert.equal(difference.case, 'stress');
  assert.equal(difference.actual, '(end of output)');
});

caseTest('an empty output is a difference, not an agreement', COMPUTE, () => {
  assert.throws(() => compare([{ name: 'go 1', output: '' }]), /go 1 printed no case/);
});

caseTest('a different Mermaid dropped object names its case', COMPUTE, () => {
  const go = 'mermaid/import/a\n| dbspec 1 imported\n= index\tb\tix_b_a_id\n';
  const ts = go.replace('= index\tb\tix_b_a_id\n', '= index\tb\tix_b_a_id\n= index\tb\tix_b_a_id\n');
  assert.deepEqual(compare([{ name: 'go 1', output: go }, { name: 'typescript 1', output: ts }]), {
    reference: 'go 1',
    other: 'typescript 1',
    case: 'mermaid/import/a',
    line: 4,
    expected: '(end of output)',
    actual: '= index\tb\tix_b_a_id',
  });
});

caseTest('an output with until equals the reference up to that line', COMPUTE, () => {
  const all = `${go}plans/cases/a\n| dbplan 1 a\n`;
  assert.equal(compare([{ name: 'go 1', output: all }, { name: 'php-extension 1', output: go, until: 'plans/' }]), null);
});

caseTest('an output with until that leaves out a case of the reference differs at that case', COMPUTE, () => {
  const all = `${go}plans/cases/a\n| dbplan 1 a\n`;
  const extension = go.slice(0, go.indexOf('stress'));
  assert.deepEqual(compare([{ name: 'go 1', output: all }, { name: 'php-extension 1', output: extension, until: 'plans/' }]), {
    reference: 'go 1',
    other: 'php-extension 1',
    case: 'stress',
    line: 6,
    expected: 'stress',
    actual: '(end of output)',
  });
});

caseTest('an output with until that goes on past that line differs there', COMPUTE, () => {
  const all = `${go}plans/cases/a\n| dbplan 1 a\n`;
  const difference = compare([{ name: 'go 1', output: all }, { name: 'php-extension 1', output: all, until: 'plans/' }]);
  assert.equal(difference.expected, '(end of output)');
  assert.equal(difference.actual, 'plans/cases/a');
});

caseTest('an until that the reference does not print is an error, not an agreement', COMPUTE, () => {
  assert.throws(() => compare([{ name: 'go 1', output: go }, { name: 'php-extension 1', output: go, until: 'plans/' }]), /go 1 has no line that starts with plans\//);
});
