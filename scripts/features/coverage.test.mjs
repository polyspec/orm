import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkCoverage, databases, executeCoverage, languages, selectFeatures } from './coverage.mjs';

const ownerTests = {
  go: 'clients/go/orm/dsn_test.go', php: 'clients/php/tests/dsn.php',
  rust: 'clients/rust/orm/tests/zone.rs', typescript: 'clients/typescript/tests/typecheck.ts',
};
const dependentTest = 'clients/go/model/model_test.go';

test('one feature can run without declaring unrelated coverage complete', { timeout: 1000 }, () => {
  const manifest = { features: [{ id: 'one' }, { id: 'two' }] };
  assert.deepEqual(selectFeatures(manifest, 'one').features, [{ id: 'one' }]);
  assert.equal(selectFeatures(manifest).features.length, 2);
  assert.throws(() => selectFeatures(manifest, 'missing'), /unknown feature missing/);
});

test('aggregate numeric TypeScript cases are owned by the client', { timeout: 1000 }, async () => {
  const root = new URL('../..', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('contracts/features.json', root), 'utf8'));
  const feature = manifest.features.find(item => item.id === 'model_queries');
  assert.ok(feature.tests.includes('clients/typescript/tests/aggregate_numeric.mjs'));
  assert.ok(!feature.tests.includes('tests/typescript/aggregate_numeric.mjs'));
  assert.ok((await stat(new URL('clients/typescript/tests/aggregate_numeric.mjs', root))).isFile());
});

test('TypeScript behavior tests stay in their client directory', { timeout: 1000 }, async () => {
  const root = new URL('../..', import.meta.url);
  const expected = ['codec-vector', 'dsn', 'engine', 'generate', 'model', 'sqlite-concurrency'];
  const entries = await readdir(new URL('clients/typescript/tests/', root));
  for (const name of expected) assert.ok(entries.includes(`${name}.mjs`), `${name}.mjs missing from owner`);
  await assert.rejects(readdir(new URL('tests/typescript/', root)), { code: 'ENOENT' });
});

function contract(kind = 'database') {
  return { features: [{ id: 'sample', status: 'implemented',
    clients: Object.fromEntries(languages.map(language => [language, 'pass'])),
    coverage: { kind, cases: ['first', 'second'],
      owners: Object.fromEntries(languages.map(language => [language, { part: `clients/${language}`,
        tests: [ownerTests[language]], commands: {} }])),
      dependents: [{ id: 'service', language: 'go', part: 'clients/go/model',
        tests: [dependentTest], cases: ['first'], commands: {} }] } }] };
}

function complete(kind = 'database') {
  const reports = {};
  const make = (role, part, tests, language, database, cases, dependent) => {
    const report = { feature: 'sample', role, part, tests, language, database, success: true, cases,
      results: cases.map((id, index) => ({ id, value_json: String(index + 1) })),
      ...(dependent ? { dependent } : {}),
      ...(kind === 'database' ? { state_before: 'digest', state_after: 'digest' } : {}) };
    return [structuredClone(report), structuredClone(report)];
  };
  for (const language of languages) for (const database of kind === 'database' ? databases : ['none']) {
    reports[`sample/owner/${language}/${database}`] = make('owner', `clients/${language}`, [ownerTests[language]], language, database, ['first', 'second']);
    if (language === 'go') reports[`sample/dependent/service/go/${database}`] = make('dependent', 'clients/go/model', [dependentTest], language, database, ['first'], 'service');
  }
  return reports;
}

function mutation(change, kind = 'database') {
  const manifest = contract(kind);
  const reports = complete(kind);
  change(manifest, reports);
  return checkCoverage(manifest, reports).join('\n');
}

test('owner and dependent cases execute in four languages and three databases', { timeout: 1000 }, () => {
  assert.deepEqual(checkCoverage(contract(), complete()), []);
  assert.deepEqual(checkCoverage(contract('independent'), complete('independent')), []);
});

test('missing owner, dependent, database, case, and repeat are RED', { timeout: 1000 }, () => {
  assert.match(mutation((m) => { m.features[0].coverage.owners.rust = undefined; }), /sample\/owner\/rust: missing owning client part/);
  assert.match(mutation((_, r) => { delete r['sample/owner/php/mysql']; }), /sample\/owner\/php\/mysql: no executed report/);
  assert.match(mutation((_, r) => { delete r['sample/dependent/service/go/mysql']; }), /sample\/dependent\/service\/go\/mysql: no executed report/);
  assert.match(mutation((m) => { delete m.features[0].coverage.dependents; }), /missing dependents declaration/);
  assert.match(mutation((m) => { m.features[0].coverage.dependents[0].part = 'clients/go'; }), /invalid dependent part/);
  assert.match(mutation((m) => { m.features[0].coverage.dependents[0].cases = []; }), /invalid dependent part, tests, or cases/);
  assert.match(mutation((m) => { m.features[0].coverage.owners.rust.tests = ['tests/conformance/check/main_test.go']; }), /tests must reside in owning part/);
  assert.match(mutation((m) => { m.features[0].coverage.owners.typescript.tests = ['tests/typescript/aggregate_numeric.mjs']; }), /tests must reside in owning part/);
  assert.match(mutation((m) => { m.features[0].coverage.owners.go.tests = [dependentTest]; }), /tests must reside in owning part/);
  assert.match(mutation((m) => { m.features[0].coverage.dependents[0].tests = [ownerTests.go]; }), /invalid dependent part, tests, or cases/);
  assert.match(mutation((m) => { m.features[0].coverage.dependents[0].tests = ['tests/conformance/check/main_test.go']; }), /invalid dependent part, tests, or cases/);
  assert.match(mutation((m) => { m.features[0].coverage.dependents[0].part = 'tests/conformance'; m.features[0].coverage.dependents[0].tests = ['tests/conformance/check/main_test.go']; }), /invalid dependent part, tests, or cases/);
  assert.match(mutation((m) => { m.features[0].coverage.owners.python = { part: 'clients/python', tests: [], commands: {} }; }), /undeclared owning client/);
  assert.match(mutation((_, r) => { r['sample/dependent/service/go/sqlite'][0].cases = []; }), /executed case IDs differ/);
  assert.match(mutation((_, r) => { r['sample/owner/typescript/postgres'].pop(); }), /exactly two executions required/);
});

test('identity, result, state, and unknown report mutations are RED', { timeout: 1000 }, () => {
  assert.match(mutation((m) => { m.features[0].clients.rust = 'planned'; }), /lacks a passing client/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][0].part = 'clients/php'; }), /report identity differs/);
  assert.match(mutation((_, r) => { r['sample/dependent/service/go/mysql'][0].role = 'owner'; }), /report identity differs/);
  assert.match(mutation((_, r) => { r['sample/dependent/service/go/mysql'][0].tests = [ownerTests.go]; }), /executed test paths differ/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][0].success = false; }), /execution failed/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][0].state_after = 'changed'; }), /database state changed/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][1].results[1].value_json = '9007199254740993'; }), /results changed/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][0].results[1].id = 'first'; }), /executed case IDs differ/);
  assert.match(mutation((_, r) => { r['sample/owner/go/mysql'][0].results[1].value_json = '{'; }), /executed case IDs differ/);
  assert.match(mutation((_, r) => { r['other/owner/go/mysql'] = r['sample/owner/go/mysql']; }), /undeclared execution report/);
  assert.match(mutation((m) => { m.features[0].coverage.cases = ['first', 'first']; }), /distinct nonempty IDs/);
});

test('native owner and dependent files execute twice from their own parts', { timeout: 8000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-')));
  const owner = 'clients/typescript/tests/owner.mjs';
  const dependent = 'clients/typescript/use/dependent.mjs';
  const manifest = { features: [{ id: 'sample', status: 'partial', clients: { typescript: 'partial' },
    coverage: { kind: 'independent', cases: ['first', 'second'],
      owners: { typescript: { part: 'clients/typescript', tests: [owner],
        commands: { none: [{ runner: 'node', test: owner, cases: ['first', 'second'] }] } } },
      dependents: [{ id: 'use', language: 'typescript', part: 'clients/typescript/use',
        tests: [dependent], cases: ['first'], commands: { none: [{ runner: 'node', test: dependent, cases: ['first'] }] } }] } }] };
  try {
    await mkdir(join(root, 'clients/typescript/tests'), { recursive: true });
    await mkdir(join(root, 'clients/typescript/use'), { recursive: true });
    await writeFile(join(root, owner), "for (const id of process.argv.slice(2)) { if (!['first', 'second'].includes(id)) process.exit(2); console.log(`CASE ${id} PASS`); }\n");
    await writeFile(join(root, dependent), "for (const id of process.argv.slice(2)) { if (id !== 'first') process.exit(2); console.log(`CASE ${id} PASS`); }\n");
    assert.deepEqual(await executeCoverage(manifest, root, 1000), []);
    await writeFile(join(root, owner), "process.stdout.write(JSON.stringify({success:true,cases:['first','second']}));\n");
    assert.match((await executeCoverage(manifest, root, 1000)).join('\n'), /unexpected test output/);
    await writeFile(join(root, owner), "for (const id of process.argv.slice(2)) { console.log(`CASE ${id} PASS`); console.log(`CASE ${id} PASS`); }\n");
    assert.match((await executeCoverage(manifest, root, 1000)).join('\n'), /duplicate observed case first/);
    delete manifest.features[0].coverage.dependents[0].commands.none;
    assert.match((await executeCoverage(manifest, root, 1000)).join('\n'), /no executable command/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Go test cache가 두 번째 실행을 대신하면 실행 증거가 아니므로, 각 실행이
// test process를 실제로 실행해 directory를 하나씩 남기는지 확인한다.
test('every Go execution runs the test instead of reading the test cache', { timeout: 120000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-go-')));
  const owner = 'clients/go/sample/sample_test.go';
  const runs = join(root, 'runs');
  const manifest = { features: [{ id: 'sample', status: 'partial', clients: { go: 'partial' },
    coverage: { kind: 'independent', cases: ['first'],
      owners: { go: { part: 'clients/go/sample', tests: [owner],
        commands: { none: [{ runner: 'go', test: owner, cases: ['first'], symbols: { first: 'TestFirst' } }] } } },
      dependents: [] } }] };
  try {
    await mkdir(join(root, 'clients/go/sample'), { recursive: true });
    await mkdir(runs);
    await writeFile(join(root, 'go.mod'), 'module sample\n\ngo 1.22\n');
    await writeFile(join(root, owner), `//go:build featurecoverage

package sample

import (
	"os"
	"testing"
)

func TestFirst(t *testing.T) {
	// Mkdir는 test cache가 기록하는 file 읽기가 아니므로 cache된 결과에는 흔적이 남지 않는다.
	if _, err := os.MkdirTemp(${JSON.stringify(runs)}, "run-"); err != nil {
		t.Fatal(err)
	}
}
`);
    assert.deepEqual(await executeCoverage(manifest, root, 60000), []);
    assert.equal((await readdir(runs)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invented JSON success from an arbitrary command is not execution evidence', { timeout: 8000 }, async () => {
  const manifest = contract('independent');
  const report = (role, part, tests, language, cases, dependent) => JSON.stringify({
    feature: 'sample', role, part, tests, language, database: 'none', success: true, cases,
    results: cases.map(id => ({ id, value_json: 'true' })), ...(dependent ? { dependent } : {}),
  });
  for (const language of languages) manifest.features[0].coverage.owners[language].commands.none =
    `node -e 'process.stdout.write(${JSON.stringify(report('owner', `clients/${language}`, [ownerTests[language]], language, ['first', 'second']))})'`;
  manifest.features[0].coverage.dependents[0].commands.none =
    `node -e 'process.stdout.write(${JSON.stringify(report('dependent', 'clients/go/model', [dependentTest], 'go', ['first'], 'service'))})'`;
  assert.match((await executeCoverage(manifest, new URL('../..', import.meta.url).pathname, 1000)).join('\n'),
    /invalid native test command/);
});

test('checker reads physical database state around each native test run', { timeout: 120000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-db-')));
  const owner = 'clients/typescript/tests/owner.mjs';
  const databasePath = join(root, 'state.sqlite');
  const dsn = `sqlite://${databasePath}`;
  const previous = process.env.ORM_COVERAGE_TEST_SQLITE_DSN;
  process.env.ORM_COVERAGE_TEST_SQLITE_DSN = dsn;
  const manifest = { features: [{ id: 'sample', status: 'partial', clients: { typescript: 'partial' },
    coverage: { kind: 'database', cases: ['first'], dependents: [], owners: {
      typescript: { part: 'clients/typescript', tests: [owner], commands: Object.fromEntries(databases.map(database =>
        [database, [{ runner: 'node', test: owner, cases: ['first'], dsn_env: 'ORM_COVERAGE_TEST_SQLITE_DSN' }]])) },
    } } }] };
  try {
    await mkdir(join(root, 'clients/typescript/tests'), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY AUTOINCREMENT, value INTEGER NOT NULL); INSERT INTO state (value) VALUES (1)');
    db.close();
    await writeFile(join(root, owner), "if (process.argv[2] !== 'first' || process.env.ORM_FEATURE_DATABASE !== 'sqlite' || process.env.ORM_FEATURE_DSN !== process.env.ORM_COVERAGE_TEST_SQLITE_DSN) process.exit(2); console.log('CASE first PASS');\n");
    // Exercise only the SQLite slot; the other database declarations are checked separately.
    const feature = manifest.features[0];
    feature.coverage.kind = 'database';
    const original = [...databases];
    assert.deepEqual(original, ['mysql', 'postgres', 'sqlite']);
    const errors = await executeCoverage(manifest, root, 30000);
    assert.ok(errors.some(error => error.includes('mysql')));
    assert.ok(errors.some(error => error.includes('postgres')));
    assert.ok(!errors.some(error => error.includes('/sqlite')), errors.join('\n'));
    await writeFile(join(root, owner), "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(new URL(process.env.ORM_COVERAGE_TEST_SQLITE_DSN).pathname); db.exec('UPDATE state SET value = value + 1'); db.close(); console.log('CASE first PASS');\n");
    const changed = await executeCoverage(manifest, root, 30000);
    assert.match(changed.join('\n'), /sample\/owner\/typescript\/sqlite: database state changed/);
  } finally {
    if (previous === undefined) delete process.env.ORM_COVERAGE_TEST_SQLITE_DSN;
    else process.env.ORM_COVERAGE_TEST_SQLITE_DSN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('Go, PHP, and Rust native cases execute through their owning files', { timeout: 120000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-native-')));
  const cases = [
    { language: 'go', part: 'clients/go/orm', file: 'clients/go/orm/owner_test.go', runner: 'go', symbol: 'TestFirst' },
    { language: 'php', part: 'clients/php/tests', file: 'clients/php/tests/owner.php', runner: 'php', id: 'first' },
    { language: 'rust', part: 'clients/rust/orm', file: 'clients/rust/orm/src/lib.rs', runner: 'cargo', symbol: 'tests::first' },
  ];
  try {
    for (const item of cases) await mkdir(join(root, item.file, '..'), { recursive: true });
    await writeFile(join(root, 'clients/go/orm/go.mod'), 'module example.com/coverage\n\ngo 1.22\n');
    await writeFile(join(root, cases[0].file), 'package orm\nimport "testing"\nfunc TestFirst(t *testing.T) {}\n');
    await writeFile(join(root, cases[1].file), '<?php\nif ($argv !== [$argv[0], "first"]) exit(2);\necho "CASE first PASS\\n";\n');
    await writeFile(join(root, 'clients/rust/orm/Cargo.toml'), '[package]\nname = "coverage_probe"\nversion = "0.0.1"\nedition = "2021"\n');
    await writeFile(join(root, cases[2].file), '#[cfg(test)] mod tests { #[test] fn first() {} }\n');
    for (const item of cases) {
      const manifest = { features: [{ id: 'sample', status: 'partial', clients: { [item.language]: 'partial' },
        coverage: { kind: 'independent', cases: ['first'], dependents: [], owners: {
          [item.language]: { part: item.part, tests: [item.file], commands: {
            none: [{ runner: item.runner, test: item.file, cases: ['first'],
              ...(item.symbol ? { symbols: { first: item.symbol } } : {}) }],
          } },
        } } }] };
      assert.deepEqual(await executeCoverage(manifest, root, 30000), [], item.language);
      if (item.symbol) {
        const command = manifest.features[0].coverage.owners[item.language].commands.none[0];
        for (const symbols of [{}, { first: item.symbol, extra: 'Unused' }, { first: 'MissingNativeTest' }]) {
          command.symbols = symbols;
          const errors = await executeCoverage(manifest, root, 30000);
          assert.match(errors.join('\n'), symbols.first === 'MissingNativeTest' ?
            /test symbol MissingNativeTest is absent/ : /invalid native test command/, item.language);
        }
        command.cases = ['first', 'second'];
        command.symbols = { first: item.symbol, second: item.symbol };
        manifest.features[0].coverage.cases = ['first', 'second'];
        assert.match((await executeCoverage(manifest, root, 30000)).join('\n'), /invalid native test command/);
      }
    }
    const go = cases[0];
    await writeFile(join(root, go.file), 'package orm\nimport "testing"\nfunc TestFirst(t *testing.T) { t.Skip("no executed pass") }\n');
    const skipped = { features: [{ id: 'sample', status: 'partial', clients: { go: 'partial' },
      coverage: { kind: 'independent', cases: ['first'], dependents: [], owners: {
        go: { part: go.part, tests: [go.file], commands: { none: [{ runner: 'go', test: go.file,
          cases: ['first'], symbols: { first: go.symbol } }] } },
      } } }] };
    assert.match((await executeCoverage(skipped, root, 30000)).join('\n'), /observed cases .* differ from TestFirst/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
