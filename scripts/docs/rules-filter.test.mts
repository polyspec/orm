import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { filterRuleFailures, implementationCountRule, onlyRuleFromArgs } from './rules-filter.mts';
import { countMismatches, declaredClientAliases, incompleteClientSets } from './implementation-count.mts';

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

caseTest('implementation counts ignore planner IDs and count the numeric client adjective', COMPUTE, () => {
  assert.deepEqual(countMismatches('79 planner IDs pass; two six-client units cover this case.', false, 6), []);
  assert.deepEqual(countMismatches('Five clients are declared.', false, 6), ['Five clients']);
  assert.deepEqual(countMismatches('여섯 클라이언트가 선언된다.', true, 6), []);
});

caseTest('client set parsing recognizes PHP library and extension aliases', COMPUTE, () => {
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
