// The unit tests of the client database lanes: the Rust thread cap of the pooler lane (T343-1), the Go owner of the
// repeated member name case of model_writes and its declaration on every owner (T343-2).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { caseTest, COMPUTE } from '../tests/testcase.mts';
import { dirname, relative, resolve } from 'node:path';
import { GO_LANE_PACKAGES, GO_LANE_SKIP, GO_DIRECT_CHECKS, goLaneSkip, poolerRecipeCommands, poolerRecipeTests, rustOwnedElsewhereSkipArguments, rustDirectRecipeSkipArguments, rustPoolerThreadArguments, rustTargetPoolSize } from './client-db-test.mts';
import { readTree } from './features/recipe-runners.mts';
import { phpScope, readTree as readNamesTree } from './features/test-names.mts';
import { parseRecipeCases } from './json/formats.mts';
import { ciGroups } from './repo/ci.mts';
import { makeTargets } from './repo/testcases.mts';
import { COMMANDS as PERF_COMMANDS } from './perf-test.mts';
import { readFeatures, type CoverageOwner, type Language, type NativeCommand } from './features/manifest.mts';

const root = resolve(import.meta.dirname, '..');
const repeatedMemberCase = 'ordered_json_keeps_a_repeated_member_name';

caseTest('the pooler lane caps the Rust test threads at the backend count per pool', COMPUTE, () => {
  assert.deepEqual(rustPoolerThreadArguments(4, 4), ['--test-threads=1']);
  assert.deepEqual(rustPoolerThreadArguments(8, 4), ['--test-threads=2']);
  assert.deepEqual(rustPoolerThreadArguments(2, 4), ['--test-threads=1']);
});

caseTest('every lane without a whole run runs every recipe test with a server through the poolers (T343-12)', COMPUTE, () => {
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
  assert.ok(poolerRecipeTests('typescript', bindings, phpText).includes('packages/ts/tests/catalog_connection-mysql.test.mjs'));
  assert.ok(!poolerRecipeTests('typescript', bindings, phpText).includes('packages/ts/tests/catalog_connection-sqlite.test.mjs'), 'a SQLite test is not a test with a server');
  // PHP holds no pool (CFG-4), so connection_pool has no PHP test with a server.
  assert.ok(!poolerRecipeTests('php', bindings, phpText).some(test => /ConnectionPool/.test(test)));
  const [php] = poolerRecipeCommands('php', ['packages/php/tests/CatalogConnectionRecipeTest.php'], '/extension.so');
  assert.deepEqual(php?.args.slice(3, 5), ['--filter', '/::test(?:Mysql|Postgres)(?: |$)/']);
});

caseTest('a recipe test runs through the poolers only when it runs a recipe of contracts/fixtures on a server', COMPUTE, () => {
  const binding = (implementation: string, test: string, recipe = 'contracts/fixtures/a/a.json') => ({ implementation, test, recipes: [recipe] });
  const bindings = [
    binding('typescript', 'packages/ts/tests/a-mysql.test.mjs'), binding('typescript', 'packages/ts/tests/a-sqlite.test.mjs'),
    binding('typescript', 'packages/ts/tests/b-postgres.test.mjs', 'tests/b/b.json'),
    binding('python', 'packages/python/tests/test_a_postgres.py'), binding('python', 'packages/python/tests/test_a_sqlite.py'),
    binding('php', 'packages/php/tests/ARecipeTest.php'), binding('php', 'packages/php/tests/BRecipeTest.php'),
  ];
  const text = (file: string) => file.endsWith('ARecipeTest.php') ? 'public function testPostgres(): void {}' : 'public function testSqlite(): void {}';
  assert.deepEqual(poolerRecipeTests('typescript', bindings, text), ['packages/ts/tests/a-mysql.test.mjs']);
  assert.deepEqual(poolerRecipeTests('python', bindings, text), ['packages/python/tests/test_a_postgres.py']);
  assert.deepEqual(poolerRecipeTests('php', bindings, text), ['packages/php/tests/ARecipeTest.php']);
});

caseTest('the Rust pool size of the integration program is read from its declaration', COMPUTE, () => {
  assert.equal(rustTargetPoolSize(root), 4);
});

caseTest('model_writes declares the repeated member name case on every owner (T343-2)', COMPUTE, () => {
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

caseTest('the Go lane leaves the measurements of PERF-1 to perf-check, which reads the bench DSNs', COMPUTE, () => {
  const skip = new RegExp(GO_LANE_SKIP);
  for (const test of ['TestPerformanceMeasurementMysql', 'TestPerformanceMeasurementPostgres', 'TestPerformanceMeasurementSQLite']) {
    assert.ok(skip.test(test), test);
    assert.ok(PERF_COMMANDS.some(command => command.includes(`^${test}$`)), `perf-check runs ${test}`);
  }
});

// A case that needs what another target passes (the server of FLOWMARK) stays out of the Rust lane (T334-3-28).
caseTest('the Rust lane skips the cases that markdown-conformance-check owns', COMPUTE, () => {
  const skipped = rustOwnedElsewhereSkipArguments(root).filter((_, index) => index % 2 === 1);
  assert.ok(skipped.includes('markdown_conformance::insert_one'), 'a markdown conformance case');
});

// The packages of go-test-check, which builds and exports what their cross-runtime tests need (T334-3-27).
const goTestCheckRoots = ['packages/go/cmd', 'packages/go/procevent', 'packages/go/internal'];

caseTest('the Go lane runs every package of packages/go that go-test-check does not run (T334-3-27)', COMPUTE, () => {
  const tracked = execFileSync('git', ['ls-files', '-z', 'packages/go/**/*.go'], { cwd: root }).toString().split('\0').filter(Boolean);
  const outputs = [...readFileSync(resolve(root, 'packages/go/models.txt'), 'utf8').matchAll(/^--set [^\n]*? --out (\S+)/gm)]
    .map(match => relative(root, resolve(root, 'packages/go', match[1] ?? '')));
  const packages = new Set([...tracked.map(file => dirname(file)), ...outputs].filter(path => !path.split('/').includes('testdata')));
  const expected = [...packages].filter(path => !goTestCheckRoots.some(owner => path === owner || path.startsWith(`${owner}/`))).map(path => `./${path}`).sort();
  assert.deepEqual([...GO_LANE_PACKAGES].sort(), expected);
});

caseTest('the Go lane leaves the markdown conformance test to the target that passes its server (T334-3-27)', COMPUTE, () => {
  const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
  assert.match(makefile, /^\tFLOWMARK=\$\(FLOWMARK\) \$\(GO_TEST\) \.\/packages\/go\/markdownmodel -run '\^TestMarkdownConformance\$\$' -count=1$/m);
  const skip = new RegExp(GO_LANE_SKIP);
  assert.ok(skip.test('TestMarkdownConformance'), 'the markdown conformance test');
  assert.ok(!skip.test('TestMarkdownConformanceHelper'), 'a skip names the whole test');
});

caseTest('the Rust lane runs the recipe programs in its workspace run and leaves out only what another target owns', COMPUTE, () => {
  const skipped = rustOwnedElsewhereSkipArguments(root).filter((_, index) => index % 2 === 1);
  for (const database of ['mysql', 'postgres', 'sqlite']) {
    assert.ok(skipped.includes(`coverage_hot_path_gate_${database}`), `the measurement of ${database}`);
    assert.ok(!skipped.includes(`model_writes_chain_${database}`), `the recipe program of ${database}`);
  }
  assert.ok(skipped.every(symbol => symbol.startsWith('markdown_conformance::') || symbol.startsWith('coverage_hot_path_gate_')), skipped.join(' '));
});

caseTest('direct Go conformance runs once while the pooler lane retains all four database cases', COMPUTE, () => {
  const source = readFileSync(resolve(root, 'packages/go/orm/recipe_conformance_verification_test.go'), 'utf8');
  const names = [...source.matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map(match => match[1] ?? '');
  assert.equal(names.length, 4);
  const direct = new RegExp(goLaneSkip(false));
  const pooler = new RegExp(goLaneSkip(true));
  for (const name of names) {
    assert.ok(direct.test(name), `${name} belongs to the dedicated direct target`);
    assert.ok(!pooler.test(name), `${name} must still exercise pooler connections`);
    assert.ok(!direct.test(`${name}Helper`), 'the skip matches exact native names');
  }
  const recipe = readFileSync(resolve(root, 'Makefile'), 'utf8').match(/^conformance-verification-check\/go:[^\n]*\n\t([^\n]+)/m)?.[1] ?? '';
  const filter = /-run '([^']+)'/.exec(recipe)?.[1]?.replaceAll('$$', '$');
  assert.ok(filter);
  for (const name of names) assert.ok(new RegExp(filter).test(name), `${name} remains executed by its dedicated target`);
});

caseTest('Rust direct conformance skips exact recipe cases and keeps the pooler run', COMPUTE, () => {
  const args = rustDirectRecipeSkipArguments(root, false);
  const symbols = args.filter((_, index) => index % 2 === 1);
  assert.ok(args.every((value, index) => index % 2 === 1 || value === '--skip'));
  assert.equal(new Set(symbols).size, symbols.length);
  assert.deepEqual(rustDirectRecipeSkipArguments(root, true), []);
  const recipeFile = resolve(root, 'contracts/fixtures/conformance_verification/conformance_verification.json');
  const recipe = parseRecipeCases(readFileSync(recipeFile, 'utf8'), recipeFile);
  const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
  const command = /^conformance-verification-check\/rust:[^\n]*\n\t([^\n]+)/m.exec(makefile)?.[1] ?? '';
  for (const database of ['mysql', 'postgres', 'sqlite', 'markdown']) {
    const target = `conformance_verification_${database}`;
    assert.ok(command.includes(`--test ${target}`), `${target} remains in the dedicated target`);
    const selected = recipe.cases.filter(entry => entry.only === undefined || entry.only.includes(database) || (database === 'markdown' && entry.only.includes('sqlite')));
    assert.deepEqual(symbols.filter(symbol => symbol.startsWith(`${target}::`)), selected.map(entry => `${target}::${entry.id}`));
  }
  assert.ok(symbols.length > 0);
  assert.ok(symbols.every(symbol => /^conformance_verification_(mysql|postgres|sqlite|markdown)::.+$/.test(symbol)));
});

caseTest('each Go direct skip has a scheduled whole-test owner and cannot skip another package', COMPUTE, () => {
  const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
  const rules = makeTargets(makefile);
  const scheduled = new Set(Object.values(ciGroups(makefile).targets).flat());
  assert.ok(Object.keys(GO_DIRECT_CHECKS).length > 1);
  const filters = Object.entries(GO_DIRECT_CHECKS).map(([target, filter]) => {
    assert.ok(scheduled.has(target), `${target} is scheduled`);
    const command = rules.filter(rule => rule.target === target).flatMap(rule => rule.commands)
      .find(command => command.includes('$(GO_TEST) ./packages/go/orm -run'));
    assert.ok(command, `${target} executes the Go package`);
    assert.equal(/-run '([^']+)' -count=1$/.exec(command)?.[1]?.replaceAll('$$', '$'), filter);
    assert.ok(!filter.includes('/'), `${target} selects full top-level tests`);
    return new RegExp(filter);
  });
  const direct = new RegExp(goLaneSkip(false));
  const pooler = new RegExp(goLaneSkip(true));
  const original = new RegExp(GO_LANE_SKIP);
  const files = execFileSync('git', ['ls-files', '-z', 'packages/go/**/*_test.go'], { cwd: root }).toString().split('\0').filter(Boolean);
  let selected = 0;
  for (const file of files) {
    if (!GO_LANE_PACKAGES.includes(`./${dirname(file)}`)) continue;
    const tests = [...readFileSync(resolve(root, file), 'utf8').matchAll(/^func (Test\w+)\(/gm)].map(match => match[1] ?? '');
    for (const name of tests) {
      const owners = dirname(file) === 'packages/go/orm' ? filters.filter(filter => filter.test(name)) : [];
      assert.ok(owners.length <= 1, `${name} has repeated dedicated owners`);
      const owned = owners.length === 1;
      assert.equal(direct.test(name), original.test(name) || owned, `${file}: ${name}`);
      assert.equal(pooler.test(name), original.test(name), `pooler: ${name}`);
      if (owned) selected++;
    }
  }
  assert.ok(selected > 4, 'more than the four conformance suites are assigned');
});
