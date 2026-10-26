import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { readParityConfig } from '../json/formats.mts';
import { parseJson } from '../json/schema.mts';
import { boundTestPaths, featureLanguages, implementationInternalTestPaths, implementationLanguages, implementationSourceRoots, implementationSupportGlobs, implementationTestGlobs, implementationTestInventory, isDeclaredSharedTest, isFeatureTestPath, isImplementationInternalTest, koreanDocumentPath, unknownParityUnits, unitTests, unlistedFeatureTestErrors } from './languages.mts';

const root = resolve(new URL('../..', import.meta.url).pathname);
const parity = readParityConfig(resolve(root, 'config/parity.json'));

caseTest('the declared implementations of config/parity.json are the feature language set', COMPUTE, () => {
  assert.deepEqual(parity.implementations.map(entry => entry.name).sort(), ['go', 'php', 'php-extension', 'python', 'rust', 'typescript']);
  assert.deepEqual(implementationLanguages(), parity.implementations.map(entry => entry.name));
});

// Each reader takes the language set from the declared implementations through implementationLanguages() and writes no
// list of its own; a hand-written list here would disagree with config/parity.json as soon as an implementation changes.
const readers = [
  'scripts/features/build.mts',
  'scripts/features/check.mts',
  'scripts/features/coverage.mts',
  'scripts/decimal-physical-check.mts',
  'tests/conformance/check/main.mts',
  'tests/conformance/check/result.physical.test.mts',
];
// A hand-written list is a literal array that names every client implementation; a subset (such as implementedLanguages
// of coverage.mts, which leaves Python out by feature) is not the set this test guards.
const literalArrays = /\[([^[\]]*)\]/g;
const clientNames = ['go', 'php', 'rust', 'typescript', 'python'];
function handWrittenSet(source: string): boolean {
  for (const [, body = ''] of source.matchAll(literalArrays)) {
    const names = new Set([...body.matchAll(/['"](\w+)['"]/g)].map(match => match[1]));
    if (clientNames.every(name => names.has(name))) return true;
  }
  return false;
}

for (const file of readers) {
  caseTest(`${file} reads the language set from config/parity.json`, COMPUTE, async () => {
    const source = await readFile(resolve(root, file), 'utf8');
    assert.equal(handWrittenSet(source), false, `${file} writes its own language list`);
    assert.match(source, /implementationLanguages\(\)|featureLanguages\(/, `${file} does not read the language set of config/parity.json`);
  });
}

// A feature's languages are the declared implementations its parity units bind, php-extension among them, and an
// undeclared unit id is reported.
caseTest('featureLanguages derives the implementations that the parity units bind', COMPUTE, () => {
  assert.deepEqual(featureLanguages(['coverage-audit-triggers-audit-history']), implementationLanguages());
  assert.deepEqual(unknownParityUnits(['coverage-audit-triggers-audit-history', 'no-such-unit']), ['no-such-unit']);
  assert.deepEqual(unitTests('coverage-audit-triggers-audit-history', 'python'), ['packages/python/tests/coverage_audit_triggers.py']);
  assert.deepEqual(unitTests('coverage-audit-triggers-audit-history', 'typescript'), ['packages/ts/tests/coverage_audit_triggers.mjs']);
  assert.deepEqual(unitTests('coverage-audit-triggers-audit-history', 'php-extension'), ['packages/php-ext/tests/CoverageAuditTriggersExtensionTest.php']);
});

caseTest('feature ownership distinguishes declared implementation-internal tests from shared behavior tests', COMPUTE, () => {
  const internal = implementationInternalTestPaths(parity);
  assert.equal(isImplementationInternalTest('go', 'packages/go/orm/split_plan_test.go', internal), true);
  assert.equal(isImplementationInternalTest('typescript', 'packages/ts/tests/split-plan.test.mjs', internal), true);
  assert.equal(isImplementationInternalTest('python', 'packages/python/tests/test_split_plan.py', internal), true);
  assert.equal(isImplementationInternalTest('go', 'packages/go/engine/fulltext_search_test.go', internal), false);
  assert.equal(isImplementationInternalTest('python', 'packages/python/tests/coverage_complex_query.py', internal), false);
});

caseTest('shared feature tests come from parity test globs or exact bindings, while support and internal files stay separate', COMPUTE, () => {
  const globs = implementationTestGlobs(parity);
  assert.equal(isDeclaredSharedTest('go', 'packages/go/orm/coverage_transactions_test.go', globs), true);
  assert.equal(isDeclaredSharedTest('go', 'packages/go/orm/coverage_fixture_test.go', globs), true);
  assert.equal(isDeclaredSharedTest('php', 'packages/php/tests/CoverageTransactionsTest.php', globs), true);
  assert.equal(isDeclaredSharedTest('php', 'packages/php/tests/CallbackFailed.php', globs), false);
  assert.equal(isDeclaredSharedTest('rust', 'packages/rust/tests/tests/integration/coverage_transactions.rs', globs), true);
  assert.equal(isDeclaredSharedTest('rust', 'packages/rust/orm/tests/common/test_support.rs', globs), false);
  assert.equal(isDeclaredSharedTest('typescript', 'packages/ts/tests/coverage_transactions.mjs', globs), true);
  assert.equal(isDeclaredSharedTest('typescript', 'packages/ts/tests/coverage_case.mjs', globs), true);
  assert.equal(isDeclaredSharedTest('python', 'packages/python/tests/coverage_transactions.py', globs), true);
  assert.equal(isDeclaredSharedTest('python', 'packages/python/tests/coverage_case.py', globs), true);
  assert.ok(boundTestPaths('go', parity).includes('packages/go/orm/transaction_api_test.go'));
  const internal = implementationInternalTestPaths(parity);
  const support = implementationSupportGlobs(parity);
  assert.equal(isFeatureTestPath('go', 'packages/go/orm/coverage_transactions_test.go', globs, [], internal, support), true);
  assert.equal(isFeatureTestPath('go', 'packages/go/orm/coverage_fixture_test.go', globs, [], internal, support), false);
  assert.equal(isFeatureTestPath('go', 'packages/go/orm/transaction_api_test.go', globs, ['packages/go/orm/transaction_api_test.go'], internal, support), true);
  assert.equal(isFeatureTestPath('go', 'packages/go/orm/mysqlonly/mysqlonly_test.go', globs, [], internal, support), true);
  assert.equal(isFeatureTestPath('php', 'packages/php/tests/PageCacheBoundCases.php', globs, boundTestPaths('php', parity), internal, support), true);
  assert.equal(isFeatureTestPath('php-extension', 'packages/php-ext/tests/ValidatorNativeTest.php', globs, boundTestPaths('php-extension', parity), internal, support), true);
  assert.equal(isFeatureTestPath('php-extension', 'packages/php-ext/tests/bootstrap.php', globs, boundTestPaths('php-extension', parity), internal, support), false);
  assert.equal(isFeatureTestPath('php', 'packages/php/tests/CannedCatalogPdo.php', globs, boundTestPaths('php', parity), internal, support), false, 'declared PHP doubles remain support files');
  assert.equal(isFeatureTestPath('rust', 'packages/rust/orm/tests/common/test_support.rs', globs, [], internal, support), false, 'declared Rust test modules remain support files');
  assert.equal(isImplementationInternalTest('python', 'packages/python/tests/entry_point_check.py', internal), true, 'the package entry-point owner test is implementation-internal');
  assert.equal(isFeatureTestPath('rust', 'packages/rust/tests/tests/common/coverage_database.rs', globs, [], internal, support), false);
  assert.equal(isFeatureTestPath('typescript', 'packages/ts/tests/coverage_performance_gate.test.mjs', globs, [], internal, support), false);
  assert.equal(isFeatureTestPath('typescript', 'packages/ts/tests/coverage_performance_report.mjs', globs, [], internal, support), false);
  assert.equal(isFeatureTestPath('php', 'packages/php/testing/interfaces/php.php', globs, boundTestPaths('php', parity), internal, support), false);
  assert.equal(isFeatureTestPath('typescript', 'packages/ts/testing/interfaces/typescript.mts', globs, boundTestPaths('typescript', parity), internal, support), false);
  assert.equal(isFeatureTestPath('python', 'packages/python/testing/interfaces/python.py', globs, boundTestPaths('python', parity), internal, support), false);
  assert.equal(isFeatureTestPath('rust', 'packages/rust/testing/interfaces/src/main.rs', globs, boundTestPaths('rust', parity), internal, support), false);
});

caseTest('an unlisted test selected by each Kit convention fails feature ownership', COMPUTE, () => {
  const cases = [
    ['go', 'packages/go/orm/new_contract_probe_test.go'],
    ['php', 'packages/php/tests/NewContractProbeTest.php'],
    ['php-extension', 'packages/php-ext/tests/NewContractProbeTest.php'],
    ['typescript', 'packages/ts/tests/new-contract-probe.test.mjs'],
    ['python', 'packages/python/tests/test_new_contract_probe.py'],
    ['rust', 'packages/rust/orm/tests/unit/new_contract_probe.rs'],
  ] as const;
  const roots = implementationSourceRoots(parity);
  const unlisted: Record<string, string[]> = {};
  for (const [language, file] of cases) {
    assert.ok((roots[language] ?? []).some(root => file.startsWith(`${root}/`)));
    assert.equal(isFeatureTestPath(language, file), true, `${language} convention-selected test cannot disappear from the feature inventory`);
    unlisted[language] = [file];
  }
  assert.deepEqual(unlistedFeatureTestErrors(unlisted, new Set()), cases.map(([language, file]) =>
    `${file}: ${language} test file belongs to no feature`));
  const goProbe = cases[0]?.[1];
  assert.ok(goProbe, 'the Go probe case is missing');
  const goInventory = implementationTestInventory([goProbe], parity).go;
  assert.ok(goInventory?.includes(goProbe), 'the checker inventory includes a convention-selected test without an explicit parity glob');
  assert.equal(isFeatureTestPath('go', 'packages/go/orm/coverage_fixture_test.go'), false, 'the explicit support glob excludes test helpers');
});

caseTest('the feature checker pairs English documents with their Korean twin exactly once', COMPUTE, () => {
  assert.equal(koreanDocumentPath('docs/spec/interfaces.md'), 'docs/spec/interfaces.ko.md');
  assert.equal(koreanDocumentPath('docs/spec/interfaces.ko.md'), 'docs/spec/interfaces.ko.md');
});

caseTest('the complex-query feature fixture declares its exact shared case and expected rows', COMPUTE, () => {
  const path = resolve(root, 'contracts/fixtures/complex_query/complex_query.json');
  const schema = resolve(root, 'scripts/features/schema/fixture.schema.json');
  const source = readFileSync(path, 'utf8');
  const fixture = parseJson<{ feature: string; cases: { id: string; operation: string; expected: { row_seqs: number[]; total_count: number } }[]; expected: { row_seqs: number[]; total_count: number } }>(source, schema, path);
  assert.equal(fixture.feature, 'complex_query');
  assert.deepEqual(fixture.cases, [{
    id: 'complex_query_product_search',
    operation: 'paginate products matching category membership and full-text terms, then fetch the declared relations',
    expected: { row_seqs: fixture.expected.row_seqs, total_count: fixture.expected.total_count },
  }]);
});
