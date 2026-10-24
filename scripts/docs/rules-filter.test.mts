import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { filterRuleFailures, implementationCountRule, onlyRuleFromArgs } from './rules-filter.mts';

caseTest('the default docs rules run preserves every finding', COMPUTE, () => {
  const failures = ['docs.translation-shape: a', 'docs.implementation-count: b'];
  assert.deepEqual(filterRuleFailures(failures, undefined), failures);
});

caseTest('a selected implementation-count run filters out unrelated findings', COMPUTE, () => {
  const failures = [
    'docs.translation-shape: a',
    'docs.implementation-count: docs/index.md counts five clients',
    'docs.implementation-count-extra: must not match the selected rule delimiter',
    'docs.writing-style: c',
  ];
  assert.deepEqual(filterRuleFailures(failures, implementationCountRule), [
    'docs.implementation-count: docs/index.md counts five clients',
  ]);
});

caseTest('the selected rule is an explicit CLI argument', COMPUTE, () => {
  assert.equal(onlyRuleFromArgs([]), undefined);
  assert.equal(onlyRuleFromArgs(['--only', implementationCountRule]), implementationCountRule);
  assert.throws(() => onlyRuleFromArgs(['--only', 'docs.writing-style']), /unsupported.*--only docs\.implementation-count/);
});

caseTest('unsupported argument shapes fail explicitly', COMPUTE, () => {
  assert.throws(() => onlyRuleFromArgs(['docs.implementation-count']), /unsupported/);
  assert.throws(() => onlyRuleFromArgs(['--only', implementationCountRule, 'extra']), /unsupported/);
});
