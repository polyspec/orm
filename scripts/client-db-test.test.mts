// The unit tests of the client database lanes: the Rust thread cap of the pooler lane (T343-1), the Go owner of the
// repeated member name case of model_writes and its declaration on every owner (T343-2).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { caseTest } from '../tests/testcase.mts';
import { dirname, relative, resolve } from 'node:path';
import { GO_LANE_PACKAGES, GO_LANE_SKIP, poolerRecipeCommands, poolerRecipeTests, rustOwnedElsewhereSkipArguments, rustPoolerThreadArguments, rustTargetPoolSize } from './client-db-test.mts';
import { readTree } from './features/recipe-runners.mts';
import { phpScope, readTree as readNamesTree } from './features/test-names.mts';
import { COMMANDS as PERF_COMMANDS } from './perf-test.mts';
import { readFeatures, type CoverageOwner, type Language, type NativeCommand } from './features/manifest.mts';

const root = resolve(import.meta.dirname, '..');
const repeatedMemberCase = 'json_keeps_a_repeated_member_name';

caseTest('the pooler lane caps the Rust test threads at the backend count per pool', () => {
  assert.deepEqual(rustPoolerThreadArguments(4, 4), ['--test-threads=1']);
  assert.deepEqual(rustPoolerThreadArguments(8, 4), ['--test-threads=2']);
  assert.deepEqual(rustPoolerThreadArguments(2, 4), ['--test-threads=1']);
});

caseTest('every lane without a whole run runs every recipe test with a server through the poolers (T343-12)', () => {
  const names = readNamesTree(root);
  const { bindings } = readTree();
  const phpText = (file: string) => phpScope(names, [file]).text;
  for (const lane of ['php', 'php-extension', 'typescript', 'python'] as const) {
    const tests = poolerRecipeTests(lane, bindings, phpText);
    assert.ok(tests.length > 0, `${lane} has recipe tests with a server`);
    const commands = poolerRecipeCommands(lane, tests, '/extension.so');
    assert.equal(commands.length, tests.length, `${lane} has one command per test`);
    tests.forEach((test, index) => {
      const named = lane === 'python' ? test.replace(/\.py$/, '').replaceAll('/', '.') : test;
      assert.ok(commands[index]?.args.includes(named), `${lane} runs ${named}`);
    });
  }
  assert.ok(poolerRecipeTests('typescript', bindings, phpText).includes('legacy/packages/ts/tests/catalog_connection-mysql.test.mjs'));
  assert.ok(!poolerRecipeTests('typescript', bindings, phpText).includes('legacy/packages/ts/tests/catalog_connection-sqlite.test.mjs'), 'a SQLite test is not a test with a server');
  // PHP holds no pool (CFG-4), so connection_pool has no PHP test with a server.
  assert.ok(!poolerRecipeTests('php', bindings, phpText).some(test => /ConnectionPool/.test(test)));
  const [php] = poolerRecipeCommands('php', ['legacy/packages/php/tests/CatalogConnectionRecipeTest.php'], '/extension.so');
  assert.deepEqual(php?.args.slice(3, 5), ['--filter', '/::test(?:Mysql|Postgres)(?: |$)/']);
});

caseTest('a recipe test runs through the poolers only when it runs a recipe of contracts/fixtures on a server', () => {
  const binding = (implementation: string, test: string, recipe = 'contracts/fixtures/a/a.json') => ({ implementation, test, recipes: [recipe] });
  const bindings = [
    binding('typescript', 'legacy/packages/ts/tests/a-mysql.test.mjs'), binding('typescript', 'legacy/packages/ts/tests/a-sqlite.test.mjs'),
    binding('typescript', 'legacy/packages/ts/tests/b-postgres.test.mjs', 'tests/b/b.json'),
    binding('python', 'legacy/packages/python/tests/test_a_postgres.py'), binding('python', 'legacy/packages/python/tests/test_a_sqlite.py'),
    binding('php', 'legacy/packages/php/tests/ARecipeTest.php'), binding('php', 'legacy/packages/php/tests/BRecipeTest.php'),
  ];
  const text = (file: string) => file.endsWith('ARecipeTest.php') ? 'public function testPostgres(): void {}' : 'public function testSqlite(): void {}';
  assert.deepEqual(poolerRecipeTests('typescript', bindings, text), ['legacy/packages/ts/tests/a-mysql.test.mjs']);
  assert.deepEqual(poolerRecipeTests('python', bindings, text), ['legacy/packages/python/tests/test_a_postgres.py']);
  assert.deepEqual(poolerRecipeTests('php', bindings, text), ['legacy/packages/php/tests/ARecipeTest.php']);
});

caseTest('the Rust pool size of the integration program is read from its declaration', () => {
  assert.equal(rustTargetPoolSize(root), 4);
});

caseTest('model_writes declares the repeated member name case on every owner (T343-2)', () => {
  const manifest = readFeatures(root);
  const feature = manifest.features.find(item => item.id === 'model_writes');
  assert.ok(feature, 'model_writes is in contracts/features.json');
  const coverage = feature.coverage;
  assert.ok(coverage, 'model_writes has a coverage part');
  assert.ok(coverage.cases.includes(repeatedMemberCase), 'the case is in the coverage cases of model_writes');
  const recipe: unknown = JSON.parse(readFileSync(resolve(root, 'contracts/fixtures/model_writes_chain/model_writes_chain.json'), 'utf8'));
  assert.ok(JSON.stringify(recipe).includes(`"id":"${repeatedMemberCase}"`), 'the case is a case of the recipe');
  const owners: readonly Language[] = ['go', 'php', 'php-extension', 'python', 'rust', 'typescript'];
  assert.deepEqual(Object.keys(coverage.owners).sort(), owners);
  for (const language of owners) {
    const part: CoverageOwner | undefined = coverage.owners[language];
    assert.ok(part, `${language} is an owner`);
    for (const database of ['mysql', 'postgres', 'sqlite'] as const) {
      const commands: NativeCommand[] | undefined = part.commands[database];
      assert.equal(commands?.length, 1, `${language} ${database} has one command`);
      const command: NativeCommand | undefined = commands?.[0];
      assert.ok(command, `${language} ${database} command`);
      assert.ok(command.cases.includes(repeatedMemberCase), `${language} ${database} runs the case`);
      assert.equal(command.recipe, 'contracts/fixtures/model_writes_chain/model_writes_chain.json', `${language} ${database} names the recipe`);
    }
  }
});

caseTest('the Go lane leaves the measurements of PERF-1 to perf-check, which reads the bench DSNs', () => {
  const skip = new RegExp(GO_LANE_SKIP);
  for (const test of ['TestPerformanceMeasurementMysql', 'TestPerformanceMeasurementPostgres', 'TestPerformanceMeasurementSQLite']) {
    assert.ok(skip.test(test), test);
    assert.ok(PERF_COMMANDS.some(command => command.includes(`^${test}$`)), `perf-check runs ${test}`);
  }
});

// A case that needs what another target passes (the server of FLOWMARK) stays out of the Rust lane (T334-3-28).
caseTest('the Rust lane skips the cases that markdown-conformance-check owns', () => {
  const skipped = rustOwnedElsewhereSkipArguments(root).filter((_, index) => index % 2 === 1);
  assert.ok(skipped.includes('markdown_conformance::insert_one'), 'a markdown conformance case');
});

// The packages of go-test-check, which builds and exports what their cross-runtime tests need (T334-3-27).
const goTestCheckRoots = ['legacy/packages/go/cmd', 'legacy/packages/go/procevent', 'legacy/packages/go/internal'];

caseTest('the Go lane runs every package of legacy/packages/go that go-test-check does not run (T334-3-27)', () => {
  const packages = new Set(readdirSync(resolve(root, 'legacy/packages/go'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.go'))
    .map(entry => relative(root, dirname(resolve(entry.parentPath, entry.name))))
    .filter(path => !path.split('/').includes('testdata')));
  const expected = [...packages].filter(path => !goTestCheckRoots.some(owner => path === owner || path.startsWith(`${owner}/`))).map(path => `./${path}`).sort();
  assert.deepEqual([...GO_LANE_PACKAGES].sort(), expected);
});

caseTest('the Go lane leaves the markdown conformance test to the target that passes its server (T334-3-27)', () => {
  const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
  assert.match(makefile, /^\tFLOWMARK=\$\(FLOWMARK\) \$\(GO_TEST\) \.\/packages\/go\/markdownmodel -run '\^TestMarkdownConformance\$\$' -count=1$/m);
  const skip = new RegExp(GO_LANE_SKIP);
  assert.ok(skip.test('TestMarkdownConformance'), 'the markdown conformance test');
  assert.ok(!skip.test('TestMarkdownConformanceHelper'), 'a skip names the whole test');
});

caseTest('the Rust lane runs the recipe programs in its workspace run and leaves out only what another target owns', () => {
  const skipped = rustOwnedElsewhereSkipArguments(root).filter((_, index) => index % 2 === 1);
  for (const database of ['mysql', 'postgres', 'sqlite']) {
    assert.ok(skipped.includes(`coverage_performance_gate::coverage_hot_path_gate_${database}`), `the measurement of ${database}`);
    assert.ok(!skipped.includes(`model_writes_chain_${database}`), `the recipe program of ${database}`);
  }
  assert.ok(skipped.every(symbol => symbol.startsWith('markdown_conformance::') || symbol.startsWith('coverage_performance_gate::coverage_hot_path_gate_')), skipped.join(' '));
});

// The entries of mariadb need the MariaDB servers, which a runner of the MySQL servers cannot hold; mariadb-recipes-check
// runs them (DIA-200, FCV-3).
caseTest('the Go lane leaves the entries of mariadb to mariadb-recipes-check/go', () => {
  const skip = new RegExp(GO_LANE_SKIP);
  assert.ok(skip.test('TestRecipeAesRotationMariadb'), 'a Go recipe entry of mariadb');
  assert.ok(skip.test('TestWithContextCancelsMariadb'), 'a Go entry of mariadb');
  assert.ok(!skip.test('TestRecipeAesRotationMysql'), 'a Go recipe entry of mysql');
  assert.ok(!skip.test('TestWithContextCancels'), 'a Go test of the MySQL servers');
});
