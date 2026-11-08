import assert from 'node:assert/strict';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';
import { setup } from '@polyspec/kit/test-hooks';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { testDirectoryOf } from './packages.mts';
import { cargoBuildArgs, cargoFeaturesForPackage, cargoModuleFilter, programCaseModules, cargoPathModuleFiles, cargoTargetArgs, cargoWorkspaceManifestPath, checkCoverage, databases, executeCoverage, resultCases, languages, NATIVE_DEADLINE, run, selectFeatures, type Coverage, type Dependent, type Feature, type Manifest, type Owner, type Report } from './coverage.mts';
import { readFeatures } from './manifest.mts';
import { readImplementations } from '../json/formats.mts';

// Synthetic manifests claim a language by a test in the first root of that implementation (contracts/implementations.json).
const implementations = readImplementations(new URL('../../contracts/implementations.json', import.meta.url).pathname);
function testsOf(claimed: string[]): string[] {
  return claimed.map(language => {
    const first = implementations.find(entry => entry.name === language)?.roots[0];
    if (first === undefined) throw new Error(`unknown fixture language ${language}`);
    return `${first}/fixture`;
  });
}
const checkSampleCoverage = (manifest: Manifest, reports: Record<string, Report[] | undefined>): string[] =>
  checkCoverage(manifest, reports);
/** The sample contract of these cases: one feature, every client owning it, and one Go dependent. */
type SampleManifest = { features: [Feature & { tests: string[]; coverage: Coverage & { owners: Record<string, Owner>; dependents: Dependent[] } }] };
/** The execution reports of the sample contract, by item key. */
type Reports = Record<string, Report[]>;

// The sample crate is not the orm workspace, so it does not use the test feature of the orm workspace that the Makefile sets.
delete process.env.ORM_RUST_TEST_FEATURES;
// A node --test of a sample entry would take this variable of the run around these cases and report to it instead of running the file.
delete process.env.NODE_TEST_CONTEXT;

const ownerTests: Record<string, string> = {
  go: 'packages/go/orm/dsn_test.go', php: 'packages/php/tests/DsnTest.php',
  'php-extension': 'packages/php-ext/tests/CatalogConnectionSurfaceTest.php', python: 'packages/python/tests/test_utils_statements.py',
  rust: 'packages/rust/orm/tests/cases/zone.rs', typescript: 'packages/ts/tests/typecheck.ts',
};
const dependentTest = 'packages/go/model/model_test.go';

// defined is a value the sample holds; a mutation of a value the sample lacks fails the case.
function defined<T>(value: T | undefined): T {
  assert.ok(value !== undefined, 'the sample holds no such value');
  return value;
}

// sampleManifest is the manifest of one independent Go feature whose only test is the owner file.
function sampleManifest(owner: string): SampleManifest {
  return { features: [{ id: 'sample', status: 'partial', tests: testsOf(['go']),
    coverage: { kind: 'independent', cases: ['first'],
      owners: { go: { part: 'packages/go/sample', tests: [owner],
        commands: { none: [{ runner: 'go', test: owner, cases: ['first'], symbol: 'TestFirst' }] } } },
      dependents: [] } }] };
}

caseTest('coverage diagnostics preserve child output when a process remains', PROCESS, async () => {
  const source = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "fs.writeSync(1, 'captured child stdout\\n');",
    "fs.writeSync(2, 'captured child stderr\\n');",
    'process.exit(0);',
  ].join(' ');
  const result = await run(process.execPath, ['-e', source], undefined, 10_000);
  assert.match(result.error ?? '', /left 1 processes:/);
  assert.match(result.error ?? '', /stdout:\ncaptured child stdout/);
  assert.match(result.error ?? '', /stderr:\ncaptured child stderr/);
});

caseTest('coverage diagnostics name a child process termination signal', PROCESS, async () => {
  const result = await run(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], undefined, 10_000);
  assert.match(result.error ?? '', /signal SIGTERM/);
});

caseTest('PHP extension coverage tests reside in the owning package', COMPUTE, () => {
  const manifest = contract();
  const reports = complete();
  const owner = manifest.features[0].coverage.owners['php-extension'];
  assert.ok(owner);
  assert.equal(testDirectoryOf('php-extension'), 'packages/php-ext');
  assert.deepEqual(checkSampleCoverage(manifest, reports), []);
  owner.tests = ['packages/php/tests/CatalogConnectionRecipeTest.php'];
  assert.match(checkSampleCoverage(manifest, reports).join('\n'), /sample\/owner\/php-extension: tests must reside in owning part/);
  const extensionTest = ownerTests['php-extension'];
  assert.ok(extensionTest);
  owner.tests = [extensionTest];
  owner.part = 'packages/php/tests';
  const mysqlReports = reports['sample/owner/php-extension/mysql'];
  assert.ok(mysqlReports?.[0]);
  mysqlReports[0].part = 'packages/php/tests';
  assert.match(checkSampleCoverage(manifest, reports).join('\n'), /sample\/owner\/php-extension: missing owning client part/);
});

caseTest('PHP extension catalog, schema and statement event coverage use native tests', COMPUTE, () => {
  const manifest = readFeatures(new URL('../..', import.meta.url).pathname);
  for (const id of ['catalog_connection', 'schema_definition', 'statement_events']) {
    const feature = manifest.features.find(item => item.id === id);
    assert.ok(feature?.coverage?.owners, `${id} has no coverage owners`);
    const owner = feature.coverage.owners['php-extension'];
    assert.ok(owner, `${id} has no PHP extension owner`);
    assert.equal(owner.part, 'packages/php-ext/tests', `${id} runs outside the extension package`);
    assert.ok(owner.tests.length > 0, `${id} has no PHP extension tests`);
    for (const test of owner.tests)
      assert.ok(test.startsWith('packages/php-ext/tests/'), `${id} declares non-extension test ${test}`);
    for (const [database, commands] of Object.entries(owner.commands)) {
      assert.ok(commands.length > 0, `${id}/${database} has no native command`);
      for (const command of commands) {
        assert.ok(owner.tests.includes(command.test), `${id}/${database} runs undeclared test ${command.test}`);
        assert.ok(command.test.startsWith('packages/php-ext/tests/'),
          `${id}/${database} runs outside the extension package: ${command.test}`);
      }
    }
  }
  const statementEvents = manifest.features.find(item => item.id === 'statement_events');
  assert.ok(statementEvents?.coverage?.owners);
  const phpOwner = statementEvents.coverage.owners.php;
  assert.ok(phpOwner);
  assert.equal(phpOwner.part, 'packages/php/tests');
  for (const command of Object.values(phpOwner.commands).flat()) {
    assert.ok(phpOwner.tests.includes(command.test), `PHP statement_events runs undeclared test ${command.test}`);
    assert.ok(command.test.startsWith('packages/php/tests/'),
      `PHP statement_events runs outside the PHP package: ${command.test}`);
  }
});

// declaredPhpMethods is the source of a PHP test class and of the parent class and traits it takes from its own
// directory, the methods PHPUnit can select in it.
function declaredPhpMethods(file: string, seen = new Set<string>()): string {
  if (seen.has(file)) return '';
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  const parents = [...source.matchAll(/^\s+use ([A-Za-z]+);$/gm), ...source.matchAll(/class \w+ extends ([A-Za-z]+)/g)];
  let methods = source;
  // An extension test class extends the shared class in packages/php/tests.
  const shared = join(dirname(dirname(dirname(file))), 'php', 'tests');
  for (const [, name] of parents)
    for (const directory of [dirname(file), shared])
      if (existsSync(join(directory, `${name}.php`))) methods += declaredPhpMethods(join(directory, `${name}.php`), seen);
  return methods;
}

// The go and php runners select their entry by its method name; the other runners run the whole file, so an entry of theirs
// names no symbol and the checker refuses one.
// Requirements: FCV-3.
caseTest('only the go and php entries name a symbol', COMPUTE, () => {
  const root = new URL('../..', import.meta.url).pathname;
  const wrong: string[] = [];
  for (const feature of readFeatures(root).features) {
    const parts = [...Object.entries(feature.coverage?.owners ?? {}), ...(feature.coverage?.dependents ?? []).map(part => [part.id, part] as const)];
    for (const [name, part] of parts)
      for (const [database, commands] of Object.entries(part.commands ?? {}))
        for (const command of commands ?? [])
          if ((command.symbol !== undefined) !== ['go', 'php'].includes(command.runner))
            wrong.push(`${feature.id}/${name}/${database}: ${command.runner} ${command.test}`);
  }
  assert.deepEqual(wrong, []);
});

caseTest('Rust coverage maps nested modules to the most specific Cargo test target', COMPUTE, () => {
  const root = new URL('../..', import.meta.url).pathname;
  const nestedIntegration = join(root, 'packages/rust/tests/tests/integration/coverage_model_writes.rs');
  const targets = [
    { name: 'integration', kind: ['test'], src_path: join(root, 'packages/rust/tests/tests/integration/main.rs'), test: true },
    { name: 'other', kind: ['test'], src_path: join(root, 'packages/rust/tests/tests/other.rs'), test: true },
  ];
  assert.deepEqual(cargoTargetArgs(targets, [nestedIntegration]), ['--test', 'integration']);

  const moduleTarget = { name: 'features', kind: ['test'],
    src_path: join(root, 'packages/rust/tests/tests/features/main.rs'), test: true };
  const libTarget = { name: 'polyspec-orm', kind: ['lib'],
    src_path: join(root, 'packages/rust/orm/src/lib.rs'), test: true };
  assert.deepEqual(cargoTargetArgs([libTarget, moduleTarget],
    [join(root, 'packages/rust/tests/tests/features/coverage_nested.rs')]), ['--test', 'features']);

  assert.throws(() => cargoTargetArgs([
    { name: 'integration', kind: ['test'], src_path: join(root, 'packages/rust/tests/tests/integration.rs'), test: true },
    { name: 'nested', kind: ['test'], src_path: join(root, 'packages/rust/tests/tests/integration/main.rs'), test: true },
  ], [nestedIntegration]), /maps to 2 Cargo test targets at its most specific module root/);
});

caseTest('Rust coverage runs a module of a test program through the filter of its module path', COMPUTE, () => {
  const root = new URL('../..', import.meta.url).pathname;
  const program = { name: 'all', kind: ['test'], src_path: join(root, 'packages/rust/tests/tests/all/main.rs'), test: true };
  const alone = { name: 'zone', kind: ['test'], src_path: join(root, 'packages/rust/orm/tests/cases/zone.rs'), test: true };
  const library = { name: 'polyspec-orm', kind: ['lib'], src_path: join(root, 'packages/rust/orm/src/lib.rs'), test: true };
  const targets = [library, program, alone];
  assert.equal(cargoModuleFilter(targets, join(root, 'packages/rust/tests/tests/all/transactions_mysql.rs')), 'transactions_mysql::');
  assert.equal(cargoModuleFilter(targets, join(root, 'packages/rust/tests/tests/all/integration_program/mod.rs')), 'integration_program::');
  assert.equal(cargoModuleFilter(targets, join(root, 'packages/rust/tests/tests/all/main.rs')), undefined);
  assert.equal(cargoModuleFilter(targets, join(root, 'packages/rust/orm/tests/cases/zone.rs')), undefined);
  assert.equal(cargoModuleFilter(targets, join(root, 'packages/rust/orm/src/driver.rs')), undefined);
});

caseTest('Rust coverage finds a test that a test case crate holds and the one program runs', COMPUTE, () => {
  const root = new URL('../..', import.meta.url).pathname;
  const main = join(root, 'packages/rust/tests/tests/all/main.rs');
  const modules = programCaseModules(main, 'Group::new("zone", polyspec_orm_cases::zone::trials),\nGroup::new("lock", polyspec_orm_build_cases::lock::trials),\nGroup::new("own", own::trials),\n');
  assert.deepEqual([...modules], [[join(root, 'packages/rust/orm/tests/cases/zone.rs'), 'zone'], [join(root, 'packages/rust/build/tests/cases/lock.rs'), 'lock']]);
});

caseTest('Rust coverage maps explicit library path modules to the library test target', COMPUTE, async () => {
  const root = new URL('../..', import.meta.url).pathname;
  const metadata = await run('cargo', ['metadata', '--no-deps', '--format-version=1', '--manifest-path', join(root, 'packages/rust/orm/Cargo.toml')], root, null, process.env, () => {});
  assert.ifError(metadata.error);
  const project: unknown = JSON.parse(metadata.stdout ?? '{}');
  assert.ok(typeof project === 'object' && project !== null && 'packages' in project && Array.isArray(project.packages),
    'Cargo metadata has no packages array');
  const isTarget = (value: unknown): value is { name: string; kind: string[]; src_path: string; test: boolean; harness?: boolean } =>
    typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string' &&
    'kind' in value && Array.isArray(value.kind) && value.kind.every((kind: unknown) => typeof kind === 'string') &&
    'src_path' in value && typeof value.src_path === 'string' && 'test' in value && typeof value.test === 'boolean' &&
    (!('harness' in value) || typeof value.harness === 'boolean');
  const pkg = project.packages.find((value: unknown): value is { name: string; targets: { name: string; kind: string[]; src_path: string; test: boolean; harness?: boolean }[] } =>
    typeof value === 'object' && value !== null && 'name' in value && value.name === 'polyspec-orm' &&
    'targets' in value && Array.isArray(value.targets) && value.targets.every(isTarget));
  assert.ok(pkg, 'Cargo metadata has no ORM package');
  const libTarget = pkg.targets.find(target => target.kind.includes('lib'));
  assert.ok(libTarget, 'Cargo metadata has no ORM library test target');
  const path = join(root, 'packages/rust/orm/tests/unit/coverage_planner.rs');
  const modules = await cargoPathModuleFiles(pkg.targets);
  assert.ok(modules.some(module => module.target === libTarget.name && module.file === path), 'the ORM library no longer declares the planner unit module');
  assert.deepEqual(cargoTargetArgs(pkg.targets, [path], modules), ['--lib']);
});

caseTest('Rust coverage uses the workspace manifest and applies only supported features to the selected crate', COMPUTE, () => {
  const root = new URL('../..', import.meta.url).pathname;
  const workspaceManifest = cargoWorkspaceManifestPath(join(root, 'packages/rust'));
  assert.equal(workspaceManifest, join(root, 'packages/rust/Cargo.toml'));
  assert.throws(() => cargoWorkspaceManifestPath(undefined), /cargo metadata has no workspace_root/);
  const orm = { name: 'polyspec-orm', manifest_path: '', targets: [], features: { 'test-faults': [] }, dependencies: [] };
  const build = { name: 'polyspec-orm-build', manifest_path: '', targets: [], features: { 'live-db': [] }, dependencies: [] };
  const tests = {
    name: 'polyspec-orm-tests', manifest_path: '', targets: [], features: {},
    dependencies: [{ name: orm.name }, { name: build.name }],
  };
  const schema = { name: 'polyspec-orm-schema', manifest_path: '', targets: [], features: {}, dependencies: [] };
  const project = { packages: [orm, build, tests, schema] };
  const requestedFeatures = ['polyspec-orm/test-faults', 'polyspec-orm-build/live-db'];
  assert.deepEqual(cargoFeaturesForPackage(project, schema, requestedFeatures), []);
  assert.deepEqual(cargoFeaturesForPackage(project, orm, requestedFeatures), ['--features', 'polyspec-orm/test-faults']);
  assert.deepEqual(cargoFeaturesForPackage(project, build, requestedFeatures), ['--features', 'polyspec-orm-build/live-db']);
  assert.deepEqual(cargoFeaturesForPackage(project, tests, requestedFeatures), ['--features', requestedFeatures.join(',')]);
  assert.deepEqual(cargoBuildArgs(
    workspaceManifest,
    'polyspec-orm-schema',
    cargoFeaturesForPackage(project, schema, requestedFeatures),
    ['--test', 'dbspec_rules'],
  ), [
    'cargo', 'test', '--no-run', '--manifest-path', workspaceManifest, '--package', 'polyspec-orm-schema',
    '--test', 'dbspec_rules', '--message-format=json-render-diagnostics',
  ]);
});

caseTest('PHP extension catalog coverage selects the exact recipe entry methods', COMPUTE, () => {
  const root = new URL('../..', import.meta.url).pathname;
  const manifest = readFeatures(root);
  const catalog = manifest.features.find(item => item.id === 'catalog_connection');
  assert.ok(catalog);
  assert.ok(catalog.coverage);
  assert.ok(catalog.coverage.owners);
  const owner = catalog.coverage.owners['php-extension'];
  assert.ok(owner);
  const commands = owner.commands;
  assert.deepEqual(Object.keys(commands).toSorted(), [...databases].toSorted());
  // The extension class extends the shared recipe class in packages/php/tests, which declares the entry methods.
  const methods = declaredPhpMethods(join(root, 'packages/php/tests/CatalogConnectionRecipeTest.php'));
  const entries: Record<string, string | undefined> = { mysql: 'testMysql', postgres: 'testPostgres', sqlite: 'testSqlite' };
  for (const [database, nativeCommands] of Object.entries(commands)) {
    assert.ok(nativeCommands);
    // SQLite also runs the recipe of its only case in a class of its own.
    assert.equal(nativeCommands.length, database === 'sqlite' ? 2 : 1);
    const entry = entries[database];
    assert.ok(entry, `no recipe entry method for ${database}`);
    assert.equal(nativeCommands[0]?.symbol, entry);
    assert.equal(nativeCommands[0]?.recipe, 'contracts/fixtures/catalog_connection/catalog_connection.json');
    assert.match(methods, new RegExp(`function ${entry}\\(`), `CatalogConnectionRecipeTest lacks ${entry}`);
    if (database === 'sqlite') {
      assert.equal(nativeCommands[1]?.symbol, entry);
      assert.equal(nativeCommands[1]?.recipe, 'contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json');
    }
  }
});

// A PHP entry selects its method by its symbol. The methods are camelCase, so an entry without the exact name makes PHPUnit
// filter for a method the class lacks and record no test execution (KSTD-7-4).
caseTest('KSTD-7-4 every case of a PHP owner selects a method of its test class', COMPUTE, () => {
  const root = new URL('../..', import.meta.url).pathname;
  const missing: string[] = [];
  let selected = 0;
  for (const feature of readFeatures(root).features)
    for (const language of ['php', 'php-extension'] as const)
      for (const [database, commands] of Object.entries(feature.coverage?.owners?.[language]?.commands ?? {}))
        for (const command of commands ?? []) {
          const methods = declaredPhpMethods(join(root, command.test));
          const method = command.symbol ?? '';
          selected += 1;
          if (!new RegExp(`function ${method}\\(`).test(methods))
            missing.push(`${feature.id}/${language}/${database}: ${command.test} ${method}`);
        }
  assert.ok(selected > 0, 'the PHP owners declare cases');
  assert.deepEqual(missing, []);
});

caseTest('one feature can run without declaring unrelated coverage complete', COMPUTE, () => {
  const manifest = { features: [{ id: 'one' }, { id: 'two' }] };
  assert.deepEqual(selectFeatures(manifest, 'one').features, [{ id: 'one' }]);
  assert.equal(selectFeatures(manifest, undefined).features.length, 2);
  assert.throws(() => selectFeatures(manifest, 'missing'), /unknown feature missing/);
});

// Requirements: FCV-6.
caseTest('selecting one feature requires only the coverage specs of that feature', COMPUTE, async () => {
  // statement_events runs in three databases for each owner client. There is no spec for other features.
  const manifest = readFeatures(new URL('../..', import.meta.url).pathname);
  const feature = manifest.features.find(item => item.id === 'statement_events');
  assert.ok(feature?.coverage?.owners);
  const selected = selectFeatures(manifest, 'statement_events');
  assert.deepEqual(selected.features.map(item => item.id), ['statement_events']);
  const missing = checkCoverage(selected, {});
  const expected = Object.keys(feature.coverage.owners).flatMap(language =>
    databases.map(database => `statement_events/owner/${language}/${database}: no executed report`));
  assert.deepEqual(missing.toSorted(), expected.toSorted());
});

caseTest('selecting coverage parts requires only those parts', COMPUTE, async () => {
  // owner-check runs only the units (--part) whose input is a changed file. It does not require items of other clients.
  const manifest = readFeatures(new URL('../..', import.meta.url).pathname);
  const selected = selectFeatures(manifest, 'statement_events', ['owner/php']);
  assert.deepEqual(checkCoverage(selected, {}).toSorted(),
    databases.map(database => `statement_events/owner/php/${database}: no executed report`).toSorted());
  // The manifest of statement_events has six owners (go, php, php-extension, rust, typescript, python), and each owner has items for each of the three databases.
  assert.equal(checkCoverage(selectFeatures(manifest, 'statement_events'), {}).length, 6 * databases.length);
  assert.throws(() => selectFeatures(manifest, 'statement_events', ['owner/cobol']),
    { message: 'unknown coverage part owner/cobol of statement_events; valid parts: owner/go, owner/php, owner/php-extension, owner/rust, owner/typescript, owner/python' });
  assert.throws(() => selectFeatures(manifest, undefined, ['owner/php']), { message: '--part needs --feature' });
});

caseTest('selecting a coverage owner, database and cases reports only that subset', COMPUTE, () => {
  const manifest = readFeatures(new URL('../..', import.meta.url).pathname);
  const selected = selectFeatures(manifest, 'constraints_and_relations', ['owner/typescript'], 'sqlite', [
    'external_relation', 'immutable_write',
  ]);
  assert.deepEqual(selected.features[0]?.coverage?.cases, ['external_relation', 'immutable_write']);
  assert.deepEqual(checkCoverage(selected, {}), [
    'constraints_and_relations/owner/typescript/sqlite: no executed report',
  ]);
  assert.throws(() => selectFeatures(manifest, 'constraints_and_relations', [], 'mysql', ['missing_case']), /unknown coverage case/);
});

caseTest('an unknown feature name fails with the list of valid names', COMPUTE, () => {
  const manifest = { features: [{ id: 'one' }, { id: 'two' }] };
  assert.throws(() => selectFeatures(manifest, 'missing'),
    { message: 'unknown feature missing; valid features: one, two' });
  assert.throws(() => selectFeatures(manifest, ''),
    { message: 'unknown feature ; valid features: one, two' });
});

caseTest('aggregate numeric TypeScript cases are owned by the client', COMPUTE, async () => {
  const root = new URL('../..', import.meta.url);
  const manifest = readFeatures(new URL('../..', import.meta.url).pathname);
  const feature = manifest.features.find(item => item.id === 'model_queries');
  assert.ok(feature?.tests);
  assert.ok(feature.tests.includes('packages/ts/tests/aggregate_numeric.mjs'));
  assert.ok(!feature.tests.includes('tests/typescript/aggregate_numeric.mjs'));
  assert.ok((await stat(new URL('packages/ts/tests/aggregate_numeric.mjs', root))).isFile());
});

caseTest('TypeScript behavior tests stay in their client directory', COMPUTE, async () => {
  const root = new URL('../..', import.meta.url);
  const expected = ['dsn', 'engine', 'generate', 'model'];
  const entries = await readdir(new URL('packages/ts/tests/', root));
  for (const name of expected) assert.ok(entries.includes(`${name}.mjs`), `${name}.mjs missing from owner`);
  await assert.rejects(readdir(new URL('tests/typescript/', root)), { code: 'ENOENT' });
});

function contract(kind = 'database'): SampleManifest {
  return { features: [{ id: 'sample', status: 'implemented',
    tests: testsOf(languages),
    coverage: { kind, cases: ['first', 'second'],
      owners: Object.fromEntries(languages.map(language => {
        const test = ownerTests[language] ?? '';
        return [language, { part: testDirectoryOf(language), tests: [test], commands: kind === 'database'
          ? Object.fromEntries(databases.map(database => [database, [{ runner: 'node', test, cases: ['first', 'second'] }]]))
          : {} }];
      })),
      dependents: [{ id: 'service', language: 'go', part: 'packages/go/model',
        tests: [dependentTest], cases: ['first'], commands: {} }] } }] };
}

// A selected owner fixture still declares all six clients; selectFeatures limits only which part the test runner executes.
function selectedSample(manifest: SampleManifest, parts: string[]): Manifest {
  const feature = defined(manifest.features[0]);
  const coverage = feature.coverage;
  const owners = coverage.owners ?? (coverage.owners = {});
  for (const language of languages) {
    const test = ownerTests[language] ?? '';
    const commands = coverage.kind === 'database'
      ? Object.fromEntries(databases.map(database => [database, [{ runner: 'node', test, cases: coverage.cases }]]))
      : {};
    owners[language] ??= { part: testDirectoryOf(language), tests: [test], commands };
  }
  feature.tests = testsOf(languages);
  return selectFeatures(manifest, feature.id, parts);
}

function runSelected(manifest: SampleManifest, root: string, parts: string[]): Promise<string[]> {
  return executeCoverage(selectedSample(manifest, parts), root, NATIVE_DEADLINE);
}

function negativeSelected(manifest: SampleManifest, root: string, parts: string[]) {
  return negative(selectedSample(manifest, parts), root);
}

function complete(kind = 'database'): Reports {
  const reports: Reports = {};
  const make = (role: string, part: string, tests: string[], language: string, database: string, cases: string[], dependent?: string): Report[] => {
    return [{ feature: 'sample', role, part, tests, language, database, success: true, cases, ...(dependent ? { dependent } : {}) }];
  };
  for (const language of languages) for (const database of kind === 'database' ? databases : ['none']) {
    reports[`sample/owner/${language}/${database}`] = make('owner', testDirectoryOf(language), [ownerTests[language] ?? ''], language, database, ['first', 'second']);
    if (language === 'go') reports[`sample/dependent/service/go/${database}`] = make('dependent', 'packages/go/model', [dependentTest], language, database, ['first'], 'service');
  }
  return reports;
}

function mutation(change: (manifest: SampleManifest, reports: Reports) => void, kind = 'database'): string {
  const manifest = contract(kind);
  const reports = complete(kind);
  change(manifest, reports);
  return checkSampleCoverage(manifest, reports).join('\n');
}

// quietly collects the console lines that run writes. executeCoverage writes a TAP `not ok - <case>` line and `# <reason>`
// lines for each failed run (tests/testcase.mts). A failure of a negative sample is made on purpose by the test, so it must
// not appear in the output of a passing run.
async function quietly<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { return { value: await run(), lines }; }
  finally { console.log = log; }
}

// tapFailures groups each `not ok - <case>` line with the `# <reason>` lines that follow it. Parallel database lines have no
// fixed order, so the groups are sorted.
function tapFailures(lines: string[]): string[] {
  const failures: string[] = [];
  let open = false;
  for (const line of lines) {
    if (line.startsWith('not ok - ')) { failures.push(line); open = true; }
    else if (line.startsWith('ok - ')) open = false;
    else if (open && line.startsWith('# ')) failures[failures.length - 1] += `\n${line}`;
  }
  return failures.toSorted();
}

// negative returns the execution errors and the TAP failure groups of a negative sample; the calling test checks the exact text.
async function negative(manifest: Manifest, root: string): Promise<{ errors: string[]; failures: string[] }> {
  const { value, lines } = await quietly(() => executeCoverage(manifest, root, NATIVE_DEADLINE));
  return { errors: value.toSorted(), failures: tapFailures(lines) };
}

// Requirements: FCV-1.
caseTest('owner and dependent cases execute in every client language and three databases', COMPUTE, () => {
  assert.deepEqual(checkSampleCoverage(contract(), complete()), []);
  assert.deepEqual(checkSampleCoverage(contract('independent'), complete('independent')), []);
});

caseTest('a shared Markdown session case requires an owner for every client', COMPUTE, () => {
  const manifest = contract('independent');
  const feature = defined(manifest.features[0]);
  feature.id = 'markdown-session';
  feature.status = 'partial';
  feature.coverage.cases = ['markdown_session'];
  feature.tests = testsOf(languages.filter(language => language !== 'python'));
  delete feature.coverage.owners.python;
  assert.match(checkSampleCoverage(manifest, {}).join('\n'), /markdown-session\/owner\/python: missing owning client part/);
});

caseTest('an implemented feature must claim every client language by its tests', COMPUTE, () => {
  assert.match(mutation((m, r) => {
    m.features[0].tests = testsOf(languages.filter(language => language !== 'python'));
    delete m.features[0].coverage.owners.python;
    for (const database of databases) delete r[`sample/owner/python/${database}`];
  }), /sample: implemented feature has no test in a client language/);
});

// Database requirements use the files explicitly assigned to each database command; shared native files may serve several databases.
caseTest('database owner files are scoped by command and every declared owner file has a database binding', COMPUTE, () => {
  const manifest = contract();
  const feature = defined(manifest.features[0]);
  const owner = defined(feature.coverage.owners.go);
  const files = ['packages/go/bench/mysql.go', 'packages/go/bench/postgres.go', 'packages/go/bench/sqlite.go'];
  owner.tests = files;
  owner.commands = Object.fromEntries(databases.map((database, index) => [database, [{
    runner: 'go', test: defined(files[index]), cases: ['first', 'second'],
  }]]));
  const reports = complete();
  for (let index = 0; index < databases.length; index++) {
    const database = defined(databases[index]);
    const report = defined(reports[`sample/owner/go/${database}`]);
    for (const execution of report) execution.tests = [defined(files[index])];
  }
  assert.deepEqual(checkSampleCoverage(manifest, reports), []);

  const rust = defined(feature.coverage.owners.rust);
  rust.tests = ['packages/rust/tests/shared.rs'];
  rust.commands = Object.fromEntries(databases.map(database => [database, [{
    runner: 'cargo', test: 'packages/rust/tests/shared.rs', cases: ['first', 'second'],
  }]]));
  for (const database of databases) {
    const report = defined(reports[`sample/owner/rust/${database}`]);
    for (const execution of report) execution.tests = ['packages/rust/tests/shared.rs'];
  }
  assert.deepEqual(checkSampleCoverage(manifest, reports), []);

  delete owner.commands.sqlite;
  assert.match(checkSampleCoverage(manifest, reports).join('\n'), /test has no database command: packages\/go\/bench\/sqlite\.go/);
});

caseTest('selected independent cases retain only the files bound to the selected case', COMPUTE, () => {
  const manifest = contract('independent');
  const feature = defined(manifest.features[0]);
  const owner = defined(feature.coverage.owners.go);
  const files = ['packages/go/bench/first.go', 'packages/go/bench/second.go'];
  owner.tests = files;
  owner.commands = { none: files.map((test, index) => ({ runner: 'go', test, cases: [index === 0 ? 'first' : 'second'] })) };
  const selected = selectFeatures(manifest, 'sample', ['owner/go'], undefined, ['first']);
  const reports = complete('independent');
  const report = defined(reports['sample/owner/go/none']);
  for (const execution of report) {
    execution.tests = [defined(files[0])];
    execution.cases = ['first'];
  }
  for (const key of Object.keys(reports)) if (key !== 'sample/owner/go/none') delete reports[key];
  assert.deepEqual(checkSampleCoverage(selected, reports), []);
});

// Requirements: FCV-5.
caseTest('missing owner, dependent, database, case, and a second run are RED', COMPUTE, () => {
  // @ts-expect-error: a missing owner is the invalid contract under test.
  assert.match(mutation((m) => { m.features[0].coverage.owners.rust = undefined; }), /sample\/owner\/rust: missing owning client part/);
  assert.match(mutation((_, r) => { delete r['sample/owner/php/mysql']; }), /sample\/owner\/php\/mysql: no executed report/);
  assert.match(mutation((_, r) => { delete r['sample/dependent/service/go/mysql']; }), /sample\/dependent\/service\/go\/mysql: no executed report/);
  // @ts-expect-error: a missing dependents declaration is the invalid contract under test.
  assert.match(mutation((m) => { delete m.features[0].coverage.dependents; }), /missing dependents declaration/);
  assert.match(mutation((m) => { defined(m.features[0].coverage.dependents[0]).part = 'packages/go'; }), /invalid dependent part/);
  assert.match(mutation((m) => { defined(m.features[0].coverage.dependents[0]).cases = []; }), /invalid dependent part, tests, or cases/);
  assert.match(mutation((m) => { defined(m.features[0].coverage.owners.rust).tests = ['tests/conformance/check/main.test.mts']; }), /tests must reside in owning part/);
  assert.match(mutation((m) => { defined(m.features[0].coverage.owners.typescript).tests = ['tests/typescript/aggregate_numeric.mjs']; }), /tests must reside in owning part/);
  assert.match(mutation((m) => { defined(m.features[0].coverage.owners.go).tests = [dependentTest]; }), /tests must reside in owning part/);
  assert.match(mutation((m) => { defined(m.features[0].coverage.dependents[0]).tests = [defined(ownerTests.go)]; }), /invalid dependent part, tests, or cases/);
  assert.match(mutation((m) => { defined(m.features[0].coverage.dependents[0]).tests = ['tests/conformance/check/main.test.mts']; }), /invalid dependent part, tests, or cases/);
  assert.match(mutation((m) => { defined(m.features[0].coverage.dependents[0]).part = 'tests/conformance'; defined(m.features[0].coverage.dependents[0]).tests = ['tests/conformance/check/main.test.mts']; }), /invalid dependent part, tests, or cases/);
  assert.match(mutation((m) => { m.features[0].coverage.owners.cobol = { part: 'packages/orm-cobol', tests: [], commands: {} }; }), /undeclared owning client/);
  assert.match(mutation((_, r) => { defined(defined(r['sample/dependent/service/go/sqlite'])[0]).cases = []; }), /executed case IDs differ/);
  assert.match(mutation((_, r) => { defined(r['sample/owner/typescript/postgres']).pop(); }), /exactly one execution required/);
  assert.match(mutation((_, r) => { const reports = defined(r['sample/owner/typescript/postgres']); reports.push(defined(reports[0])); }), /exactly one execution required/);
});

// Requirements: FCV-5.
caseTest('identity, result and unknown report mutations are RED', COMPUTE, () => {
  assert.match(mutation((m) => { m.features[0].tests = testsOf(languages.filter(language => language !== 'rust')); }), /has no test in a client language/);
  assert.match(mutation((_, r) => { defined(defined(r['sample/owner/go/mysql'])[0]).part = 'packages/php'; }), /report identity differs/);
  assert.match(mutation((_, r) => { defined(defined(r['sample/dependent/service/go/mysql'])[0]).role = 'owner'; }), /report identity differs/);
  assert.match(mutation((_, r) => { defined(defined(r['sample/dependent/service/go/mysql'])[0]).tests = [defined(ownerTests.go)]; }), /executed test paths differ/);
  assert.match(mutation((_, r) => { defined(defined(r['sample/owner/go/mysql'])[0]).success = false; }), /execution failed/);
  assert.match(mutation((_, r) => { defined(defined(r['sample/owner/go/mysql'])[0]).cases = ['first', 'first']; }), /executed case IDs differ/);
  assert.match(mutation((_, r) => { r['other/owner/go/mysql'] = defined(r['sample/owner/go/mysql']); }), /undeclared execution report/);
  assert.match(mutation((m) => { m.features[0].coverage.cases = ['first', 'first']; }), /distinct nonempty IDs/);
});

// reportingEntry is the source of a test entry for the node runner: it appends the line of each id to the results file.
const reportingEntry = (lines: string[]): string =>
  `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.ORM_RECIPE_RESULTS, ${JSON.stringify(lines.map(line => `${line}\n`).join(''))});\n`;

caseTest('owner and dependent entries execute once from their own parts', PROCESS, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-')));
  const owner = 'packages/ts/tests/owner.mjs';
  const dependent = 'packages/ts/use/dependent.mjs';
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', tests: testsOf(['typescript']),
    coverage: { kind: 'independent', cases: ['first', 'second'],
      owners: { typescript: { part: 'packages/ts', tests: [owner],
        commands: { none: [{ runner: 'node', test: owner, cases: ['first', 'second'] }] } } },
      dependents: [{ id: 'use', language: 'typescript', part: 'packages/ts/use',
        tests: [dependent], cases: ['first'], commands: { none: [{ runner: 'node', test: dependent, cases: ['first'] }] } }] } }] };
  try {
    await mkdir(join(root, 'packages/ts/tests'), { recursive: true });
    await mkdir(join(root, 'packages/ts/use'), { recursive: true });
    await writeFile(join(root, owner), reportingEntry(['CASE first PASS', 'CASE second PASS']));
    await writeFile(join(root, dependent), reportingEntry(['CASE first PASS']));
    assert.deepEqual(await runSelected(manifest, root, ['owner/typescript', 'dependent/use']), []);

    const incomplete = structuredClone(manifest);
    const sample = defined(incomplete.features[0]);
    const sampleCoverage = defined(sample.coverage);
    const typescriptOwner = defined(sampleCoverage.owners.typescript);
    const noneCommands = defined(typescriptOwner.commands?.none);
    const command = defined(noneCommands[0]);
    command.cases = ['first'];
    assert.deepEqual(await runSelected(incomplete, root, ['owner/typescript']), [
      'sample/owner/typescript/none: invalid test command',
      'sample/owner/typescript/none: no executed report',
    ].toSorted());

    const none = 'sample/owner/typescript/none: exactly one execution required';
    await writeFile(join(root, owner), '');
    assert.deepEqual((await runSelected(manifest, root, ['owner/typescript'])).toSorted(), [
      'sample/owner/typescript/none: observed no cases differ from first,second', none,
    ].toSorted());

    // What a test prints is no evidence: only the lines of the results file are read.
    await writeFile(join(root, owner), `console.log('{"success":true,"cases":["first","second"]}'); console.log('CASE first PASS'); console.log('CASE second PASS');\n`);
    assert.deepEqual((await runSelected(manifest, root, ['owner/typescript'])).toSorted(), [
      'sample/owner/typescript/none: observed no cases differ from first,second', none,
    ].toSorted());
    const unexpected = '{"success":true,"cases":["first","second"]}';
    await writeFile(join(root, owner), reportingEntry([unexpected]));
    assert.deepEqual(await negativeSelected(manifest, root, ['owner/typescript', 'dependent/use']), {
      errors: [`sample/owner/typescript/none: unexpected test output: ${unexpected}`, none].toSorted(),
      failures: [`not ok - sample/owner/typescript/none run\n# unexpected test output: ${unexpected}`],
    });
    await writeFile(join(root, owner), reportingEntry(['CASE first PASS', 'CASE first PASS']));
    assert.deepEqual(await negativeSelected(manifest, root, ['owner/typescript', 'dependent/use']), {
      errors: ['sample/owner/typescript/none: duplicate observed case first', none].toSorted(),
      failures: ['not ok - sample/owner/typescript/none run\n# duplicate observed case first'],
    });
    delete defined(defined(manifest.features[0].coverage.dependents[0]).commands).none;
    assert.deepEqual(await negativeSelected(manifest, root, ['owner/typescript', 'dependent/use']), {
      errors: ['sample/dependent/use/typescript/none: no executable command', 'sample/dependent/use/typescript/none: no executed report',
        'sample/owner/typescript/none: duplicate observed case first', none].toSorted(),
      failures: ['not ok - sample/owner/typescript/none run\n# duplicate observed case first'],
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

caseTest('every Go execution runs the test instead of reading the test cache', PROCESS, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-go-')));
  const owner = 'packages/go/sample/sample_test.go';
  const runs = join(root, 'runs');
  const manifest = sampleManifest(owner);
  try {
    await mkdir(join(root, 'packages/go/sample'), { recursive: true });
    await mkdir(runs);
    await writeFile(join(root, 'go.mod'), 'module sample\n\ngo 1.22\n');
    await writeFile(join(root, owner), `package sample

import (
	"os"
	"testing"
)

func TestFirst(t *testing.T) {
	// Mkdir는 test cache가 기록하는 file 읽기가 아니므로 cache된 결과에는 흔적이 남지 않는다.
	if _, err := os.MkdirTemp(${JSON.stringify(runs)}, "run-"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("ORM_RECIPE_RESULTS"), []byte("CASE first PASS\\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}
`);
    assert.deepEqual(await runSelected(manifest, root, ['owner/go']), []);
    assert.deepEqual(await runSelected(manifest, root, ['owner/go']), []);
    assert.equal((await readdir(runs)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// GO_REPORTING_TEST is a Go test TestFirst that writes its line, without its package clause.
const GO_REPORTING_TEST = `import ("os"; "testing")\nfunc TestFirst(t *testing.T) { if err := os.WriteFile(os.Getenv("ORM_RECIPE_RESULTS"), []byte("CASE first PASS\\n"), 0o600); err != nil { t.Fatal(err) } }\n`;

// Requirements: FCV-2.
caseTest('a Go test of the normal go test build is read by its exact name', PROCESS, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-go-tags-')));
  const owner = 'packages/go/sample/sample_test.go';
  const body = (tag: string) => `${tag}package sample\n\n${GO_REPORTING_TEST}\nfunc TestFirstOther(t *testing.T) { t.Fatal("selected by a prefix") }\n`;
  try {
    await mkdir(join(root, 'packages/go/sample'), { recursive: true });
    await writeFile(join(root, 'go.mod'), 'module sample\n\ngo 1.22\n');
    // The tag of the normal go test (GO_TEST_TAGS): a test that the normal run holds is a test that the checker reads.
    await writeFile(join(root, owner), body('//go:build ormtest\n\n'));
    assert.deepEqual(await runSelected(sampleManifest(owner), root, ['owner/go']), []);
    // A tag of no run leaves the test out of the checker too, as it does out of the normal go test.
    await writeFile(join(root, owner), body('//go:build othertag\n\n'));
    assert.match((await runSelected(sampleManifest(owner), root, ['owner/go'])).join('\n'), /build constraints exclude/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A slow but normal build runs to the end with no deadline. The go in front of PATH waits 3 s and then runs the real go, so
// the test binary build takes 3 s or more, and the build and the run pass.
caseTest('a slow but healthy coverage build runs to its end without a deadline', PROCESS, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-slow-')));
  const owner = 'packages/go/sample/sample_test.go';
  const manifest = sampleManifest(owner);
  const path = process.env.PATH;
  try {
    const goRoot = execFileSync('go', ['env', 'GOROOT']).toString().trim();
    const realGo = join(goRoot, 'bin/go');
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(join(root, 'bin/go'), `#!/bin/sh\nsleep 3\nexec ${JSON.stringify(realGo)} "$@"\n`);
    await chmod(join(root, 'bin/go'), 0o755);
    await mkdir(join(root, 'packages/go/sample'), { recursive: true });
    await writeFile(join(root, 'go.mod'), 'module sample\n\ngo 1.22\n');
    await writeFile(join(root, owner), `package sample\n\n${GO_REPORTING_TEST}`);
    process.env.PATH = `${join(root, 'bin')}:${path}`;
    const started = performance.now();
    assert.deepEqual(await runSelected(manifest, root, ['owner/go']), []);
    assert.ok(performance.now() - started >= 3000, 'the build ran through the slow go');
  } finally {
    process.env.PATH = path;
    await rm(root, { recursive: true, force: true });
  }
});

// phpunitStub writes, under root, a vendor-php/bin/phpunit that stands for PHPUnit: it requires the arguments with
// which coverage.mts runs a PHP entry, runs the PHP code `before`, and appends the lines `lines` to the results file.
async function phpunitStub(root: string, file: string, lines: string[], before = '', method = 'testFirst'): Promise<void> {
  const want = ['--configuration', join(root, 'packages/php/phpunit.xml.dist'), '--filter', `/::${method}( |$)/`, join(root, file)];
  await mkdir(join(root, 'vendor-php/bin'), { recursive: true });
  await writeFile(join(root, 'vendor-php/bin/phpunit'), `<?php\nif (array_slice($argv, 1) !== ${phpArray(want)}) exit(2);\n${before}file_put_contents(getenv('ORM_RECIPE_RESULTS'), ${JSON.stringify(lines.map(line => `${line}\n`).join(''))}, FILE_APPEND);\n`);
}

function phpArray(list: string[]): string {
  return `[${list.map((item: string) => JSON.stringify(item)).join(', ')}]`;
}

const PASSED = ['CASE first PASS'];

// Requirements: FCV-2.
caseTest('PHP coverage cases use their explicitly declared method symbols', PROCESS, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-php-symbols-')));
  const file = 'packages/php/tests/OwnerTest.php';
  const method = 'testSchemaInstallExisting';
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', tests: testsOf(['php']),
    coverage: { kind: 'independent', cases: ['schema_install_existing'], dependents: [], owners: {
      php: { part: 'packages/php/tests', tests: [file], commands: { none: [{ runner: 'php', test: file,
        cases: ['schema_install_existing'], symbol: method }] } },
    } } }] };
  try {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), '<?php\n');
    await phpunitStub(root, file, ['CASE schema_install_existing PASS'], '', method);
    assert.deepEqual(await runSelected(manifest, root, ['owner/php']), []);

    const command = defined(defined(defined(defined(manifest.features[0].coverage).owners).php?.commands?.none)[0]);
    for (const symbol of ['OwnerTest::testSchemaInstallExisting', undefined]) {
      if (symbol === undefined) delete command.symbol;
      else command.symbol = symbol;
      assert.match((await runSelected(manifest, root, ['owner/php'])).join('\n'), /invalid test command/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The Rust build overlap case (G5.123) checks that a run not using the cargo test binary does not wait for the Rust build. The cargo at the front of PATH
// waits until it reads the FIFO in `cargo test --no-run`, that is, until the PHP case writes to that FIFO, and then runs the real cargo. From the manifest,
// since the Rust owner comes before the PHP owner, if runs start only after the build finishes, or run only in line order, the build and the PHP
// cases wait for each other and fail at the case deadline.
// exportLease sets LEASE and CARGO_LEASES as make exports them. The lease program is a stub that runs the command after
// `--`: these cases assert the build gate and the execution, not the exclusion of the lease. It returns the restore.
async function exportLease(root: string): Promise<() => void> {
  await mkdir(join(root, 'lease-bin'), { recursive: true });
  const program = join(root, 'lease-bin/lease');
  await writeFile(program, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
  await chmod(program, 0o755);
  const saved = { LEASE: process.env.LEASE, CARGO_LEASES: process.env.CARGO_LEASES };
  process.env.LEASE = program;
  process.env.CARGO_LEASES = join(root, 'leases');
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

// The fixture crate of the overlap case is written and built in a setup, a long operation without a deadline, so the
// `cargo test --no-run` of the case finds it built and only the FIFO decides the overlap, whatever the load (T335).
const overlapRustFile = 'packages/rust/orm/src/lib.rs';
let overlapRoot = '';
setup('coverage overlap fixture crate', async () => {
  overlapRoot = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-overlap-')));
  await mkdir(join(overlapRoot, overlapRustFile, '..'), { recursive: true });
  await writeFile(join(overlapRoot, 'packages/rust/Cargo.toml'), '[workspace]\nmembers = ["orm"]\nresolver = "2"\n');
  await writeFile(join(overlapRoot, 'packages/rust/orm/Cargo.toml'), '[package]\nname = "coverage_overlap"\nversion = "0.0.1"\nedition = "2021"\n');
  await writeFile(join(overlapRoot, overlapRustFile), '#[cfg(test)] mod tests { #[test] fn first() { std::fs::write(std::env::var_os("ORM_RECIPE_RESULTS").unwrap(), "CASE first PASS\\n").unwrap(); } }\n');
  execFileSync('cargo', ['test', '--no-run', '--manifest-path', join(overlapRoot, 'packages/rust/Cargo.toml'), '--package', 'coverage_overlap', '--lib'], { stdio: 'inherit' });
});

caseTest('coverage runs without cargo proceed while the Rust test build runs', PROCESS, async () => {
  const root = overlapRoot;
  const rustFile = overlapRustFile;
  const phpFile = 'packages/php/tests/OwnerTest.php';
  const fifo = join(root, 'build-gate');
  const written = join(root, 'written');
  const cargoArguments = join(root, 'cargo-arguments');
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', tests: testsOf(['rust', 'php']),
    coverage: { kind: 'independent', cases: ['first'], dependents: [], owners: {
      rust: { part: 'packages/rust/orm', tests: [rustFile], commands: { none: [{ runner: 'cargo', test: rustFile, cases: ['first'] }] } },
      php: { part: 'packages/php/tests', tests: [phpFile], commands: { none: [{ runner: 'php', test: phpFile, cases: ['first'], symbol: 'testFirst' }] } },
    } } }] };
  const path = process.env.PATH;
  let restoreLease = (): void => {};
  try {
    restoreLease = await exportLease(root);
    const realCargo = execFileSync('sh', ['-c', 'command -v cargo']).toString().trim();
    await mkdir(join(root, 'bin'), { recursive: true });
    execFileSync('mkfifo', [fifo]);
    await writeFile(join(root, 'bin/cargo'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(cargoArguments)}\ncase " $* " in *" test "*"--no-run "*) read gate < ${JSON.stringify(fifo)} ;; esac\nexec ${JSON.stringify(realCargo)} "$@"\n`);
    await chmod(join(root, 'bin/cargo'), 0o755);
    await mkdir(join(root, phpFile, '..'), { recursive: true });
    // The run writes to the FIFO. The write waits until cargo opens the FIFO to read it.
    await writeFile(join(root, phpFile), '<?php\n');
    await phpunitStub(root, phpFile, PASSED, `if (!file_exists(${JSON.stringify(written)})) { file_put_contents(${JSON.stringify(fifo)}, "go\\n"); touch(${JSON.stringify(written)}); }\n`);
    process.env.PATH = `${join(root, 'bin')}:${path}`;
    assert.deepEqual(await runSelected(manifest, root, ['owner/rust', 'owner/php']), []);
    const cargoCalls = (await readFile(cargoArguments, 'utf8')).split('\n').filter(Boolean);
    const testBuild = cargoCalls.find(args => args.startsWith('test '));
    assert.ok(testBuild, 'Cargo test build was invoked');
    assert.match(testBuild, /--package coverage_overlap/);
    assert.match(testBuild, /--lib/);
    assert.doesNotMatch(testBuild, /--workspace/);
  } finally {
    process.env.PATH = path;
    restoreLease();
    await rm(root, { recursive: true, force: true });
  }
});

caseTest('invented JSON success from an arbitrary command is not execution evidence', PROCESS, async () => {
  const manifest = contract('independent');
  const report = (role: string, part: string, tests: string[], language: string, cases: string[], dependent?: string) => JSON.stringify({
    feature: 'sample', role, part, tests, language, database: 'none', success: true, cases,
    ...(dependent ? { dependent } : {}),
  });
  for (const language of languages) {
    // @ts-expect-error: a shell command in place of native test commands is the invalid contract under test.
    defined(defined(manifest.features[0].coverage.owners[language]).commands).none =
      `node -e 'process.stdout.write(${JSON.stringify(report('owner', testDirectoryOf(language), [ownerTests[language] ?? ''], language, ['first', 'second']))})'`;
  }
  // @ts-expect-error: a shell command in place of native test commands is the invalid contract under test.
  defined(defined(manifest.features[0].coverage.dependents[0]).commands).none =
    `node -e 'process.stdout.write(${JSON.stringify(report('dependent', 'packages/go/model', [dependentTest], 'go', ['first'], 'service'))})'`;
  assert.match((await executeCoverage(manifest, new URL('../..', import.meta.url).pathname, NATIVE_DEADLINE)).join('\n'),
    /invalid test command/);
});

// An entry of a database item takes the lines of its database from a file of its own; the database comes from the case
// databases of the run (FCV-9), so the checker reads no DSN and no state of a shared database.
// Requirements: FCV-4.
// Requirements: FCV-14.
caseTest('a run is the exit status of its entry and the lines it wrote', PROCESS, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-')));
  const fileOf = (database: string) => `packages/ts/tests/${database}.mjs`;
  const recipe = 'contracts/fixtures/sample/sample.json';
  const manifest = (): SampleManifest => ({
    features: [{ id: 'sample', status: 'partial', tests: testsOf(['typescript']),
      coverage: { kind: 'database', cases: ['first'], dependents: [], owners: {
        typescript: { part: 'packages/ts', tests: databases.map(fileOf), commands: Object.fromEntries(databases.map(database =>
          [database, [{ runner: 'node', test: fileOf(database), cases: ['first'], recipe }]])) },
      } } }] });
  try {
    await mkdir(join(root, 'packages/ts/tests'), { recursive: true });
    await mkdir(join(root, 'contracts/fixtures/sample'), { recursive: true });
    await writeFile(join(root, recipe), '{"cases":[{"id":"first"}]}\n');
    for (const database of databases)
      await writeFile(join(root, fileOf(database)), reportingEntry([`CASE first [${database}] PASS`]));
    assert.deepEqual(await runSelected(manifest(), root, ['owner/typescript']), []);
    // A line of another database, or without its database, is refused: an entry runs on its own database.
    await writeFile(join(root, fileOf('sqlite')), reportingEntry(['CASE first [mysql] PASS']));
    assert.match((await runSelected(manifest(), root, ['owner/typescript'])).join('\n'), /sample\/owner\/typescript\/sqlite: unexpected test output: CASE first \[mysql\] PASS/);
    await writeFile(join(root, fileOf('sqlite')), reportingEntry(['CASE first PASS']));
    assert.match((await runSelected(manifest(), root, ['owner/typescript'])).join('\n'), /unexpected test output: CASE first PASS/);
    // A failing entry fails however many lines it wrote.
    await writeFile(join(root, fileOf('sqlite')), `${reportingEntry(['CASE first [sqlite] PASS'])}process.exit(3);\n`);
    assert.match((await quietly(() => runSelected(manifest(), root, ['owner/typescript']))).value.join('\n'), /sample\/owner\/typescript\/sqlite: exit 1/);
    // A native entry of FCV-2 has no database.
    const native = manifest();
    delete defined(defined(defined(native.features[0].coverage.owners.typescript).commands)['sqlite'])[0]?.recipe;
    assert.match((await runSelected(native, root, ['owner/typescript'])).join('\n'), /sample\/owner\/typescript\/sqlite: invalid test command/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Requirements: FCV-3.
caseTest('Go, PHP, and Rust native cases execute through their owning files', PROCESS, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-native-')));
  const cases: { language: string; part: string; file: string; runner: string; symbol?: string }[] = [
    { language: 'go', part: 'packages/go/orm', file: 'packages/go/orm/owner_test.go', runner: 'go', symbol: 'TestFirst' },
    { language: 'php', part: 'packages/php/tests', file: 'packages/php/tests/OwnerTest.php', runner: 'php', symbol: 'testFirst' },
    { language: 'rust', part: 'packages/rust/orm', file: 'packages/rust/orm/src/lib.rs', runner: 'cargo' },
  ];
  let restoreLease = (): void => {};
  try {
    restoreLease = await exportLease(root);
    for (const item of cases) await mkdir(join(root, item.file, '..'), { recursive: true });
    await writeFile(join(root, 'packages/go/orm/go.mod'), 'module example.com/coverage\n\ngo 1.22\n');
    await writeFile(join(root, defined(cases[0]).file), `package orm\n${GO_REPORTING_TEST}`);
    await writeFile(join(root, defined(cases[1]).file), '<?php\n');
    await phpunitStub(root, defined(cases[1]).file, PASSED);
    await writeFile(join(root, 'packages/rust/orm/Cargo.toml'), '[package]\nname = "coverage_probe"\nversion = "0.0.1"\nedition = "2021"\n');
    // Like cargo test, the CARGO_MANIFEST_DIR at run time is the package directory that owns the test file.
    await writeFile(join(root, defined(cases[2]).file), '#[cfg(test)] mod tests { #[test] fn first() { ' +
      'assert_eq!(std::env::var("CARGO_MANIFEST_DIR").as_deref(), Ok(env!("CARGO_MANIFEST_DIR"))); ' +
      'std::fs::write(std::env::var_os("ORM_RECIPE_RESULTS").unwrap(), "CASE first PASS\\n").unwrap(); } }\n');
    for (const item of cases) {
      const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', tests: testsOf([item.language]),
        coverage: { kind: 'independent', cases: ['first'], dependents: [], owners: {
          [item.language]: { part: item.part, tests: [item.file], commands: {
            none: [{ runner: item.runner, test: item.file, cases: ['first'],
              ...(item.symbol ? { symbol: item.symbol } : {}) }],
          } },
        } } }] };
      assert.deepEqual(await runSelected(manifest, root, [`owner/${item.language}`]), [], item.language);
      if (item.language === 'go') {
        const command = defined(defined(defined(defined(manifest.features[0].coverage.owners[item.language]).commands).none)[0]);
        command.symbol = 'MissingNativeTest';
        assert.match((await runSelected(manifest, root, [`owner/${item.language}`])).join('\n'), /test symbol MissingNativeTest is absent/, item.language);
      }
    }
    // If there is no test binary that compiles a declared Rust test file, a test of the same name in another file
    // is not execution evidence.
    const unused = 'packages/rust/orm/src/unused.rs';
    await writeFile(join(root, unused), '#[test] fn first() {}\n');
    const uncompiled: SampleManifest = { features: [{ id: 'sample', status: 'partial', tests: testsOf(['rust']),
      coverage: { kind: 'independent', cases: ['first'], dependents: [], owners: {
        rust: { part: 'packages/rust/orm', tests: [unused], commands: { none: [{ runner: 'cargo', test: unused, cases: ['first'] }] } },
      } } }] };
    assert.match((await runSelected(uncompiled, root, ['owner/rust'])).join('\n'), /no test binary compiles .*unused\.rs/);
    // A skipped Go test exits 0 and writes no line, so it is no pass.
    const go = defined(cases[0]);
    await writeFile(join(root, go.file), 'package orm\nimport "testing"\nfunc TestFirst(t *testing.T) { t.Skip("no executed pass") }\n');
    const skipped: SampleManifest = { features: [{ id: 'sample', status: 'partial', tests: testsOf(['go']),
      coverage: { kind: 'independent', cases: ['first'], dependents: [], owners: {
        go: { part: go.part, tests: [go.file], commands: { none: [{ runner: 'go', test: go.file, cases: ['first'], symbol: go.symbol ?? '' }] } },
      } } }] };
    const message = 'observed no cases differ from first';
    assert.deepEqual(await negativeSelected(skipped, root, ['owner/go']), {
      errors: [`sample/owner/go/none: ${message}`, 'sample/owner/go/none: exactly one execution required'].toSorted(),
      failures: [`not ok - sample/owner/go/none run\n# ${message}`],
    });
  } finally {
    restoreLease();
    await rm(root, { recursive: true, force: true });
  }
});

// A Python owner runs on the interpreter that make names in ORM_PYTHON, as its module of the test package from the checkout
// root. The
// interpreter here is a stand-in that checks those arguments, so the checker's part is tested without a Python.
caseTest('Python cases execute on the interpreter of ORM_PYTHON', PROCESS, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-python-')));
  const owner = 'packages/python/tests/owner.py';
  const interpreter = join(root, 'bin/python');
  const previous = process.env.ORM_PYTHON;
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', tests: testsOf(['python']),
    coverage: { kind: 'independent', cases: ['first'], dependents: [],
      owners: { python: { part: 'packages/python/tests', tests: [owner],
        commands: { none: [{ runner: 'python', test: owner, cases: ['first'] }] } } } } }] };
  try {
    await mkdir(join(root, 'packages/python/tests'), { recursive: true });
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, owner), '');
    await writeFile(interpreter, `#!/bin/sh\n[ "$#" = 2 ] && [ "$1" = -m ] && [ "$2" = packages.python.tests.owner ] && [ "$PWD" = ${JSON.stringify(root)} ] || exit 2\necho 'CASE first PASS' >> "$ORM_RECIPE_RESULTS"\n`);
    await chmod(interpreter, 0o755);
    process.env.ORM_PYTHON = interpreter;
    assert.deepEqual(await runSelected(manifest, root, ['owner/python']), []);
    defined(defined(defined(defined(manifest.features[0].coverage.owners.python).commands).none)[0]).runner = 'node';
    assert.match((await runSelected(manifest, root, ['owner/python'])).join('\n'), /invalid test command/);
    defined(defined(defined(defined(manifest.features[0].coverage.owners.python).commands).none)[0]).runner = 'python';
    delete process.env.ORM_PYTHON;
    assert.match((await runSelected(manifest, root, ['owner/python'])).join('\n'), /ORM_PYTHON is unset; run this through make, which exports it/);
  } finally {
    if (previous === undefined) delete process.env.ORM_PYTHON;
    else process.env.ORM_PYTHON = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// executeCoverage writes each run's native command as one line, then its result as a TAP line (`ok - <case>` or
// `not ok - <case>`). A failed run gives its reason on `# <reason>` lines.
caseTest('every native run reports its command and TAP result', PROCESS, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-report-')));
  const owner = 'packages/ts/tests/owner.mjs';
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', tests: testsOf(['typescript']),
    coverage: { kind: 'independent', cases: ['first'], dependents: [],
      owners: { typescript: { part: 'packages/ts', tests: [owner],
        commands: { none: [{ runner: 'node', test: owner, cases: ['first'] }] } } } } }] };
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await mkdir(join(root, 'packages/ts/tests'), { recursive: true });
    await writeFile(join(root, owner), reportingEntry(['CASE first PASS']));
    assert.deepEqual(await runSelected(manifest, root, ['owner/typescript']), []);
    await writeFile(join(root, owner), 'process.exit(3);\n');
    assert.match((await runSelected(manifest, root, ['owner/typescript'])).join('\n'), /none: exit 1/);
  } finally {
    console.log = log;
    await rm(root, { recursive: true, force: true });
  }
  const expected = [
    `^node ${owner}$`,
    '^ok - sample/owner/typescript/none run$',
    `^node ${owner}$`,
    '^not ok - sample/owner/typescript/none run$',
    '^# exit 1: ',
  ];
  assert.ok(lines.length >= expected.length, lines.join('\n'));
  lines.forEach((line, index) => assert.match(line, new RegExp(expected[index] ?? ''), lines.join('\n')));
});

// The deadline of one native process of a coverage run is an outer bound against a hung process; each test bounds its own
// work by the class it declares (testcase.Start, caseTest), the longest of which is PROCESS. A shorter outer bound stops a
// test inside its own deadline, as it stopped the Go model_generation case (testcase.Process) after 120000 ms (T185).
caseTest('a coverage process deadline is not shorter than the longest declared test class', COMPUTE, () => {
  assert.ok(NATIVE_DEADLINE >= PROCESS, `NATIVE_DEADLINE ${NATIVE_DEADLINE} ms is shorter than PROCESS ${PROCESS} ms`);
});

// The deadline stops a process that does not end. The process here never ends, so the case holds on any machine under any load;
// every other case passes NATIVE_DEADLINE and no run that is merely slow can reach it.
caseTest('a process that never ends is stopped at its deadline', PROCESS, async () => {
  const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], undefined, 100);
  assert.equal(result.error, 'timeout after 100 ms');
  const { pid } = result;
  assert.ok(pid !== undefined, 'the run reports the pid it started');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

// A results file of a database item holds `CASE <id> [<database>] PASS` lines of its database; a line without the database or
// of another database is refused.
caseTest('database items take their own [database] lines and refuse plain or other lines', COMPUTE, () => {
  assert.deepEqual(resultCases('CASE first [sqlite] PASS\nCASE second [sqlite] PASS\n', ['first', 'second'], 'sqlite'), ['first', 'second']);
  assert.throws(() => resultCases('CASE first PASS\n', ['first'], 'sqlite'), /unexpected test output: CASE first PASS/);
  assert.throws(() => resultCases('CASE first [oracle] PASS\n', ['first'], 'sqlite'), /unexpected test output/);
  assert.throws(() => resultCases('CASE first [sqlite] PASS\nCASE first [sqlite] PASS\n', ['first'], 'sqlite'), /duplicate observed case first/);
  assert.throws(() => resultCases('CASE first [sqlite] PASS\n', ['first', 'second'], 'sqlite'), /differ/);
  assert.deepEqual(resultCases('CASE first PASS\n', ['first']), ['first']);
  assert.throws(() => resultCases('CASE first [sqlite] PASS\n', ['first']), /unexpected test output/);
  assert.throws(() => resultCases('', ['first']), /observed no cases differ from first/);
});
