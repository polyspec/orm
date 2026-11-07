// The unit tests of the client database lanes: the Rust thread cap of the pooler lane (T343-1), the Go owner of the
// repeated member name case of model_writes and its declaration on every owner (T343-2).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isolatedEnvironment } from '../tests/environment.mts';
import { execFileSync, spawnSync } from 'node:child_process';
import { caseTest, COMPUTE } from '../tests/testcase.mts';
import { dirname, relative, resolve } from 'node:path';
import { GO_LANE_PACKAGES, GO_LANE_SKIP, GO_DIRECT_CHECKS, goLaneSkip, poolerRecipeCommands, poolerRecipeUnits, rustOwnedElsewhereSkipArguments, rustDirectRecipeSkipArguments, rustPoolerThreadArguments, rustTargetPoolSize } from './client-db-test.mts';
import { readParityConfig } from './json/formats.mts';
import { ciGroups } from './repo/ci.mts';
import { groupOutputs } from './check/ci-setup.mts';
import { declaredNeeds } from './check/inputs.mts';
import { makeTargets } from './repo/testcases.mts';
import { COMMANDS as PERF_COMMANDS } from './perf-test.mts';
import { readFeatures, type CoverageOwner, type Language, type NativeCommand } from './features/manifest.mts';
import { matchesAny } from '@polyspec/kit/glob';
import { implementationEnvironment } from './check/implementation-environment.mts';
import { readJsonFile } from './json/schema.mts';

const root = resolve(import.meta.dirname, '..');
const repeatedMemberCase = 'ordered_json_keeps_a_repeated_member_name';

caseTest('Rust message zone cases use the declared immutable process fixture', COMPUTE, () => {
  const config = readParityConfig(resolve(root, 'config/parity.json'));
  const environment = implementationEnvironment(config, 'rust', { TZ: 'UTC' }, root);
  const recipe = readJsonFile<{ cases: { id: string; steps: { process_zone?: string }[] }[] }>(resolve(root, 'tests/bind/messages.json'), resolve(root, 'scripts/features/schema/recipe.schema.json'));
  let zones = 0;
  for (const item of recipe.cases) for (const step of item.steps) if (step.process_zone !== undefined) {
    assert.equal(environment.TZ, step.process_zone, `${item.id}: the fixture exists before case execution`);
    zones++;
  }
  assert.ok(zones > 0, 'the process-zone regression cases remain registered');
  const source = readFileSync(resolve(root, 'packages/rust/tests/src/recipe.rs'), 'utf8');
  assert.doesNotMatch(source, /std::env::(?:set_var|remove_var)\s*\(/, 'the shared helper never mutates the running process environment');
});

caseTest('the pooler lane caps the Rust test threads at the backend count per pool', COMPUTE, () => {
  assert.deepEqual(rustPoolerThreadArguments(4, 4), ['--test-threads=1']);
  assert.deepEqual(rustPoolerThreadArguments(8, 4), ['--test-threads=2']);
  assert.deepEqual(rustPoolerThreadArguments(2, 4), ['--test-threads=1']);
});

caseTest('every lane without a whole run runs every recipe unit with a database through the poolers (T343-12)', COMPUTE, () => {
  const units = readParityConfig(resolve(root, 'config/parity.json')).units;
  const recipes = poolerRecipeUnits(units);
  assert.ok(recipes.length > 0, 'the recipe units are found');
  assert.ok(recipes.every(unit => /-(mysql|postgres)$/.test(unit.id)), 'a unit without a database server is not listed');
  for (const lane of ['php', 'php-extension', 'typescript', 'python'] as const) {
    const commands = poolerRecipeCommands(lane, units, '/extension.so');
    // A suite that names its runtimes in its owner parts leaves the others out.
    const owned = recipes.filter(unit => unit.owner?.parts === undefined || unit.owner.parts.includes(`owner/${lane}`));
    assert.equal(commands.length, owned.length, `${lane} has one command per unit`);
    owned.forEach((unit, index) => {
      const test = unit.bindings?.find(binding => binding.implementation === lane)?.test ?? '';
      const named = lane === 'python' ? test.replace(/\.py$/, '').replaceAll('/', '.') : test;
      assert.ok(commands[index]?.args.includes(named), `${lane} runs ${unit.id} with ${named}`);
    });
  }
  const catalog = recipes.find(unit => unit.id === 'catalog_connection-mysql');
  assert.ok(catalog, 'catalog_connection-mysql is listed');
  const php = poolerRecipeCommands('php', [catalog], '/extension.so')[0];
  assert.deepEqual(php?.args.slice(3, 5), ['--filter', 'testMysql']);
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
  const recipe = JSON.parse(readFileSync(resolve(root, 'contracts/fixtures/conformance_verification/conformance_verification.json'), 'utf8')) as { cases: { id: string; only?: string[] }[] };
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

caseTest('client database dry-run shows all six lanes without executing a command or requiring live DSNs', COMPUTE, () => {
  const tools = mkdtempSync(resolve(tmpdir(), 'orm-client-dry-run-'));
  const marker = resolve(tools, 'executed');
  try {
    for (const name of ['go', 'cargo', 'make', 'php', 'python', 'python3', 'node', 'npm', 'composer']) {
      const file = resolve(tools, name);
      writeFileSync(file, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.exitCode=77;\n`);
      chmodSync(file, 0o755);
    }
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/client-db-test.mts'), '--dry-run'], {
      cwd: root, env: isolatedEnvironment({ PATH: tools, HOME: tools }), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const plan: unknown = JSON.parse(result.stdout);
    assert.ok(typeof plan === 'object' && plan !== null && 'mode' in plan && 'lanes' in plan && 'order' in plan);
    assert.equal(plan.mode, 'dry-run');
    assert.equal(plan.order, 'serial');
    assert.ok(Array.isArray(plan.lanes));
    assert.deepEqual(plan.lanes.map((entry: unknown) => {
      assert.ok(typeof entry === 'object' && entry !== null && 'name' in entry);
      return entry.name;
    }), ['go', 'php', 'php-extension', 'typescript', 'python', 'rust']);
    const rust: unknown = plan.lanes.find((entry: unknown) => typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === 'rust');
    assert.ok(typeof rust === 'object' && rust !== null && 'native' in rust && Array.isArray(rust.native));
    const native: unknown = rust.native[0];
    assert.ok(typeof native === 'object' && native !== null && 'environment' in native);
    assert.deepEqual(native.environment, { TZ: 'America/New_York' });
    assert.match(result.stdout, /tests\/go-test\.mts/);
    assert.match(result.stdout, /tests\/cargo-test\.mts/);
    assert.match(result.stdout, /php-ext-build/);
    const parallel = spawnSync(process.execPath, [resolve(root, 'scripts/client-db-test.mts'), '--dry-run'], {
      cwd: root, env: isolatedEnvironment({ PATH: tools, HOME: tools, ORM_CLIENT_DB_LANGS: 'go,rust,php-extension',
        ORM_CLIENT_DB_LANES: 'parallel', ORM_CLIENT_DB_POOLER: '1' }), encoding: 'utf8',
    });
    assert.equal(parallel.status, 0, parallel.stdout + parallel.stderr);
    const selected: unknown = JSON.parse(parallel.stdout);
    assert.ok(typeof selected === 'object' && selected !== null && 'order' in selected && 'lanes' in selected);
    assert.equal(selected.order, 'parallel');
    assert.ok(Array.isArray(selected.lanes));
    assert.deepEqual(selected.lanes.map((entry: unknown) => {
      assert.ok(typeof entry === 'object' && entry !== null && 'name' in entry);
      return entry.name;
    }), ['go', 'php-extension', 'rust']);
    assert.equal(parallel.stdout.includes('TestAcquireSQLiteRowLock'), false, 'the pooler keeps cases excluded only from direct runs');
    for (const args of [['--dry-run'], ['--dry-rnu']]) {
      const invalid = spawnSync(process.execPath, [resolve(root, 'scripts/client-db-test.mts'), ...args], {
        cwd: root, env: isolatedEnvironment({ PATH: tools, HOME: tools, ORM_CLIENT_DB_LANGS: 'not-a-client' }), encoding: 'utf8',
      });
      assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
    }
    assert.equal(existsSync(marker), false, 'no build, installation or test command runs');
  } finally { rmSync(tools, { recursive: true, force: true }); }
});

caseTest('each direct and pooler recipe prepares its own codes and the interface schema reader', COMPUTE, () => {
  const targets = makeTargets(readFileSync(resolve(root, 'Makefile'), 'utf8'));
  const owned: Record<string, string[]> = {
    go: ['lease-tool'], rust: ['lease-tool'],
    php: ['php-vendor-check', 'php-models'],
    'php-extension': ['php-vendor-check', 'php-models', 'php-extension-tools-check'],
    typescript: ['typescript-current'], python: ['python-venv-check'],
  };
  for (const [runtime, expected] of Object.entries(owned)) for (const prefix of ['client-db', 'client-pooler']) {
    const name = `${prefix}-${runtime}-check`;
    const target = targets.find(entry => entry.target === name);
    assert.ok(target, name);
    assert.equal(target.prerequisites.includes('orm-codes'), false, `${name} must not generate all other client codes`);
    if (runtime !== 'typescript') assert.ok(target.prerequisites.includes('orm-codes-typescript'), `${name}: interface schema reader`);
    for (const prerequisite of expected) assert.ok(target.prerequisites.includes(prerequisite), `${name}: ${prerequisite}`);
  }
});

caseTest('the Go client job does not install PHP or Python for cross-runtime checks', COMPUTE, () => {
  const groups = ciGroups(readFileSync(resolve(root, 'Makefile'), 'utf8')).targets;
  assert.ok(groups.clients_db?.includes('go-test-check'), 'the cross-runtime dialect and generator checks have a cross-runtime job');
  const outputs = groupOutputs(groups.client_db_go ?? [], declaredNeeds(root));
  for (const runtime of ['php', 'python', 'rust', 'php-extension-tools']) assert.equal(outputs[runtime], false, runtime);
  assert.equal(outputs.go, true);
});

caseTest('SHOW CREATE parity observes public results while private parser checks keep their native owners', COMPUTE, () => {
  const parity = readParityConfig(resolve(root, 'config/parity.json'));
  assert.equal(parity.units.some(unit => unit.id === 'dbspec-show-create'), false,
    'a private parser observation must not be declared as a shared public recipe run');
  assert.equal(matchesAny(parity.suites ?? [], 'tests/dbspec/show-create.json'), false, 'the raw vector input is not another public suite');
  const reader = parity.units.find(unit => unit.id === 'dbspec-show-create-reader-text');
  assert.ok(reader, 'the separately restored reader-text evidence remains declared');
  assert.ok(reader.requirements?.includes('DIA-84'));
  const publicSuite = parity.units.find(unit => unit.id === 'dbspec-show-create-check-body');
  assert.ok(publicSuite);
  assert.deepEqual(publicSuite.bindings?.map(binding => binding.implementation), parity.implementations.map(implementation => implementation.name));
  const privateFiles: Record<string, string> = {
    go: 'packages/go/engine/dbspec/show_create_test.go',
    php: 'packages/php/tests/DbspecShowCreateTest.php',
    typescript: 'packages/ts/tests/dbspec-show-create.mjs',
    python: 'packages/python/tests/test_dbspec_show_create.py',
    rust: 'packages/rust/schema/src/dbspec/introspect/mysql.rs',
  };
  for (const [runtime, file] of Object.entries(privateFiles)) {
    assert.ok(reader.bindings?.some(binding => binding.implementation === runtime && binding.test === file), `${runtime}: its specification-backed parser test stays bound`);
    assert.ok(existsSync(resolve(root, file)), `${runtime}: its native test is preserved`);
  }
  const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
  const targets = makeTargets(makefile);
  const runs = (target: string, selected: string) => assert.ok(targets.find(entry => entry.target === target)?.commands.some(command => command.includes(selected)), `${target} runs ${selected}`);
  assert.ok(GO_LANE_PACKAGES.includes('./packages/go/engine/dbspec'));
  assert.equal(new RegExp(goLaneSkip(false)).test('TestMySQLShownCheckVectors'), false);
  runs('dbspec-php-check/show-create', privateFiles.php ?? '');
  runs('dbspec-ts-check', privateFiles.typescript ?? '');
  runs('dbspec-rust-check/show-create/unit', '-p polyspec-orm-schema --lib show_create_tests');
  runs('python-unit-check', '$(PYTHON_UNIT_MODULES)');
  const dedicated = /^PYTHON_DEDICATED_MODULES = (.*)$/m.exec(makefile)?.[1]?.split(/\s+/) ?? [];
  assert.equal(dedicated.includes('packages.python.tests.test_dbspec_show_create'), false);
  const scheduled = Object.values(ciGroups(makefile).targets).flat();
  const features = readFeatures(root).features;
  const reaches = (target: string, wanted: string, seen = new Set<string>()): boolean => {
    if (target === wanted) return true;
    if (seen.has(target)) return false;
    seen.add(target);
    return targets.filter(entry => entry.target === target).flatMap(entry => entry.prerequisites).some(child => reaches(child, wanted, seen));
  };
  for (const target of ['client-db-go-check', 'dbspec-php-check', 'dbspec-ts-check', 'dbspec-rust-check', 'python-unit-check']) {
    const verified = features.some(feature => feature.verification.some(command => command.command === `make ${target}` && scheduled.includes(`feature-verify-${command.shard}`)));
    assert.ok(scheduled.some(parent => reaches(parent, target)) || verified, `${target} runs in a CI group or its feature verification`);
  }
});
