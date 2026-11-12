import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { readImplementations, type Implementation } from '../json/formats.mts';
import { featureLanguages, implementationFiles, implementationLanguages, implementationOf, implementationTestInventory, koreanDocumentPath, unlistedFeatureTestErrors } from './languages.mts';

const root = resolve(new URL('../..', import.meta.url).pathname);
const implementations = readImplementations(resolve(root, 'contracts/implementations.json'));

caseTest('the implementations of contracts/implementations.json are the feature language set', COMPUTE, () => {
  assert.deepEqual(implementations.map(entry => entry.name).sort(), ['go', 'php', 'php-extension', 'python', 'rust', 'typescript']);
  assert.deepEqual(implementationLanguages(), implementations.map(entry => entry.name));
});

// Each reader takes the language set from the declared implementations through implementationLanguages() and writes no
// list of its own; a hand-written list here would disagree with contracts/implementations.json as soon as an implementation changes.
const readers = [
  'scripts/features/build.mts',
  'scripts/features/coverage.mts',
  'scripts/decimal-physical-check.mts',
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
  caseTest(`${file} reads the language set from contracts/implementations.json`, COMPUTE, async () => {
    const source = await readFile(resolve(root, file), 'utf8');
    assert.equal(handWrittenSet(source), false, `${file} writes its own language list`);
    assert.match(source, /implementationLanguages\(\)|featureLanguages\(/, `${file} does not read the language set of contracts/implementations.json`);
  });
}

// A feature's languages are the implementations whose roots hold one of its tests, php-extension among them; a root outside
// packages (examples, benchmarks/rust) belongs to its implementation too.
caseTest('featureLanguages derives the implementations whose roots hold the tests', COMPUTE, () => {
  assert.deepEqual(featureLanguages(['legacy/packages/php-ext/tests/AuditTriggersRecipeTestExtensionTest.php', 'legacy/packages/go/orm/codec_test.go']), ['go', 'php-extension']);
  assert.equal(implementationOf('legacy/packages/php-ext/tests/x.php'), 'php-extension');
  assert.equal(implementationOf('legacy/packages/php/tests/x.php'), 'php');
  assert.equal(implementationOf('examples/dsn_test.go'), 'go');
  assert.equal(implementationOf('benchmarks/rust/src/native.rs'), 'rust');
  assert.equal(implementationOf('docs/test_outside.py'), undefined);
  assert.deepEqual(featureLanguages(['docs/spec/x.md']), []);
});

const probe: Implementation = {
  name: 'go', roots: ['legacy/packages/go'], tests: ['**/*_test.go'],
  support: ['legacy/packages/go/orm/test_helpers_test.go'], internal: [{ glob: 'legacy/packages/go/orm/split_plan_test.go', reason: 'internal' }],
};

caseTest('the test inventory is the files its globs select, less its support files and internal tests', COMPUTE, () => {
  const files = ['legacy/packages/go/orm/codec_test.go', 'legacy/packages/go/orm/test_helpers_test.go', 'legacy/packages/go/orm/split_plan_test.go', 'legacy/packages/go/orm/codec.go', 'docs/x_test.go'];
  assert.deepEqual(implementationTestInventory(files, [probe]), { tests: { go: ['legacy/packages/go/orm/codec_test.go'] }, stale: [] });
});

caseTest('a support or internal glob that selects no test file is stale', COMPUTE, () => {
  const { stale } = implementationTestInventory(['legacy/packages/go/orm/codec_test.go', 'legacy/packages/go/orm/split_plan_test.go'], [probe]);
  assert.deepEqual(stale, ['go: legacy/packages/go/orm/test_helpers_test.go selects no test file of legacy/packages/go']);
});

caseTest('the declared inventory of this checkout has no stale declaration, and names its support and internal files', COMPUTE, () => {
  const inventory = implementationTestInventory(implementationFiles(root));
  assert.deepEqual(inventory.stale, []);
  assert.equal(inventory.tests['go']?.includes('legacy/packages/go/orm/test_helpers_test.go'), false, 'a declared Go support file is no feature test');
  assert.equal(inventory.tests['php-extension']?.includes('legacy/packages/php-ext/tests/ValidatorNativeTest.php'), false, 'a declared internal test is no feature test');
  assert.equal(inventory.tests['go']?.includes('legacy/packages/go/model/coverage_schema_install_test.go'), true);
  assert.equal(inventory.tests['typescript']?.includes('legacy/packages/ts/tests/coverage_transactions.mjs'), true);
});

caseTest('an unlisted test selected by the globs of each implementation fails feature ownership', COMPUTE, () => {
  const cases = [
    ['go', 'legacy/packages/go/orm/new_contract_probe_test.go'],
    ['php', 'legacy/packages/php/tests/NewContractProbeTest.php'],
    ['php-extension', 'legacy/packages/php-ext/tests/NewContractProbeTest.php'],
    ['typescript', 'legacy/packages/ts/tests/new-contract-probe.test.mjs'],
    ['python', 'legacy/packages/python/tests/test_new_contract_probe.py'],
    ['rust', 'packages/rust/orm/tests/unit/new_contract_probe.rs'],
  ] as const;
  const { tests } = implementationTestInventory(cases.map(([, file]) => file));
  for (const [language, file] of cases) assert.deepEqual(tests[language], [file], `${language} selects ${file}`);
  assert.deepEqual(unlistedFeatureTestErrors(tests, new Set()), cases.map(([language, file]) => `${file}: ${language} test file belongs to no feature`));
});

caseTest('the feature checker pairs English documents with their Korean twin exactly once', COMPUTE, () => {
  assert.equal(koreanDocumentPath('docs/spec/interfaces.md'), 'docs/spec/interfaces.ko.md');
  assert.equal(koreanDocumentPath('docs/spec/interfaces.ko.md'), 'docs/spec/interfaces.ko.md');
});

// A generated file that the repository ignores is no test file: the fixture models that make python-models writes into
// legacy/packages/python/tests/models matched the Python test glob on disk, and the feature check named them a test of no feature,
// while only the files Git tracks or would track are files of the tree (T339-17).
caseTest('the implementation files are the checked files of the roots, without the files Git ignores', COMPUTE, () => {
  const base = mkdtempSync(join(tmpdir(), 'orm-feature-files-'));
  try {
    mkdirSync(join(base, 'legacy/packages/python/tests/models'), { recursive: true });
    mkdirSync(join(base, 'docs'), { recursive: true });
    writeFileSync(join(base, '.gitignore'), '/legacy/packages/python/tests/models/models.py\n');
    writeFileSync(join(base, 'legacy/packages/python/tests/test_tracked.py'), '');
    writeFileSync(join(base, 'legacy/packages/python/tests/test_untracked.py'), '');
    writeFileSync(join(base, 'legacy/packages/python/tests/models/__init__.py'), '');
    writeFileSync(join(base, 'legacy/packages/python/tests/models/models.py'), '');
    writeFileSync(join(base, 'docs/test_outside.py'), '');
    execFileSync('git', ['init', '-q'], { cwd: base });
    execFileSync('git', ['add', '.gitignore', 'legacy/packages/python/tests/test_tracked.py'], { cwd: base });
    const python = implementations.filter(entry => entry.name === 'python').map(entry => ({ ...entry, roots: ['legacy/packages/python'] }));
    assert.deepEqual(implementationFiles(base, python), [
      'legacy/packages/python/tests/models/__init__.py',
      'legacy/packages/python/tests/test_tracked.py',
      'legacy/packages/python/tests/test_untracked.py',
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
