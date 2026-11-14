import assert from 'node:assert/strict';
import { caseTest } from '../../tests/testcase.mts';
import { filterRuleFailures, implementationCountRule, onlyRuleFromArgs } from './rules-filter.mts';
import { countMismatches, declaredClientAliases, incompleteClientSets } from './implementation-count.mts';

caseTest('the default docs rules run preserves every finding', () => {
  const failures = ['docs.translation-shape: a', 'docs.implementation-count: b'];
  assert.deepEqual(filterRuleFailures(failures, undefined), failures);
});

caseTest('a selected implementation-count run filters out unrelated findings', () => {
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

caseTest('the selected rule is an explicit CLI argument', () => {
  assert.equal(onlyRuleFromArgs([]), undefined);
  assert.equal(onlyRuleFromArgs(['--only', implementationCountRule]), implementationCountRule);
  assert.throws(() => onlyRuleFromArgs(['--only', 'docs.writing-style']), /unsupported.*--only docs\.implementation-count/);
});

caseTest('unsupported argument shapes fail explicitly', () => {
  assert.throws(() => onlyRuleFromArgs(['docs.implementation-count']), /unsupported/);
  assert.throws(() => onlyRuleFromArgs(['--only', implementationCountRule, 'extra']), /unsupported/);
});

caseTest('implementation counts ignore planner IDs and count the numeric client adjective', () => {
  assert.deepEqual(countMismatches('79 planner IDs pass; two six-client units cover this case.', false, 6), []);
  assert.deepEqual(countMismatches('Five clients are declared.', false, 6), ['Five clients']);
  assert.deepEqual(countMismatches('여섯 클라이언트가 선언된다.', true, 6), []);
});

caseTest('the number of a rule identifier is no implementation count', () => {
  assert.deepEqual(countMismatches('CORE-41 to CORE-43 and CORE-106 to CORE-109 have no implementation.', false, 6), []);
  assert.deepEqual(countMismatches('K812 clients read it, and INT-5 runners run it.', false, 6), []);
  assert.deepEqual(countMismatches('CORE-109 구현은 없다.', true, 6), []);
  assert.deepEqual(countMismatches('The rule CORE-109 names 5 implementations.', false, 6), ['5 implementations']);
  assert.deepEqual(countMismatches('규칙 CORE-109는 5 구현을 적는다.', true, 6), ['5 구현']);
});

caseTest('client set parsing recognizes PHP library and extension aliases', () => {
  const display = { go: 'Go', php: 'PHP', 'php-extension': 'PHP extension', typescript: 'TypeScript', python: 'Python', rust: 'Rust' };
  const aliases = declaredClientAliases(Object.keys(display), display);
  assert.deepEqual(
    incompleteClientSets('Each of the six native clients—Go, PHP library, PHP extension, TypeScript, Python and Rust is tested.', aliases),
    [],
  );
  assert.deepEqual(
    incompleteClientSets('Every implementation (Go, PHP, the PHP-extension, TypeScript, Python, and Rust) is tested.', aliases),
    [],
  );
  assert.deepEqual(
    incompleteClientSets('The clients are Go, PHP, TypeScript and Rust.', aliases),
    [{ line: 1, phrase: 'Go, PHP, TypeScript and Rust', missing: ['PHP extension', 'Python'] }],
  );
});
