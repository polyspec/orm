import assert from 'node:assert/strict';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { chmod, mkdtemp, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { packageDirectoryOf } from './packages.mts';
import { checkCoverage, databases, executeCoverage, observedCases, languages, NATIVE_DEADLINE, selectFeatures, type Coverage, type Dependent, type Feature, type Manifest, type Owner, type Report } from './coverage.mts';
import { readFeatures } from './manifest.mts';

/** The sample contract of these cases: one feature, every client owning it, and one Go dependent. */
type SampleManifest = { features: [Feature & { clients: Record<string, string>; coverage: Coverage & { owners: Record<string, Owner>; dependents: Dependent[] } }] };
/** The execution reports of the sample contract, by item key. */
type Reports = Record<string, Report[]>;

// sample crate는 orm workspace가 아니므로 Makefile이 정한 orm workspace의 test feature를 쓰지 않는다.
delete process.env.ORM_RUST_TEST_FEATURES;

const ownerTests: Record<string, string> = {
  go: 'packages/go/orm/dsn_test.go', php: 'packages/php/tests/DsnTest.php', python: 'packages/python/tests/test_utils.py',
  rust: 'packages/rust/orm/tests/zone.rs', typescript: 'packages/ts/tests/typecheck.ts',
};
const dependentTest = 'packages/go/model/model_test.go';

// defined is a value the sample holds; a mutation of a value the sample lacks fails the case.
function defined<T>(value: T | undefined): T {
  assert.ok(value !== undefined, 'the sample holds no such value');
  return value;
}

// 각 case의 기한: memory 안의 검사는 1 s, node process 몇 개를 실행하는 case는 8 s, Go test
// binary, Rust test binary나 state reader를 build하고 실행하는 case는 120 s다.
caseTest('one feature can run without declaring unrelated coverage complete', 1000, () => {
  const manifest = { features: [{ id: 'one' }, { id: 'two' }] };
  assert.deepEqual(selectFeatures(manifest, 'one').features, [{ id: 'one' }]);
  assert.equal(selectFeatures(manifest, undefined).features.length, 2);
  assert.throws(() => selectFeatures(manifest, 'missing'), /unknown feature missing/);
});

caseTest('selecting one feature requires only the coverage specs of that feature', 1000, async () => {
  // statement_events는 소유 client마다 세 database에서 두 번 실행한다. 다른 기능의 spec은 없다.
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

caseTest('selecting coverage parts requires only those parts', 1000, async () => {
  // owner-check는 바뀐 file이 입력인 단위(--part)만 실행한다. 다른 client의 항목은 요구하지 않는다.
  const manifest = readFeatures(new URL('../..', import.meta.url).pathname);
  const selected = selectFeatures(manifest, 'statement_events', ['owner/php']);
  assert.deepEqual(checkCoverage(selected, {}).toSorted(),
    databases.map(database => `statement_events/owner/php/${database}: no executed report`).toSorted());
  // statement_events의 manifest는 다섯 owner(go, php, rust, typescript, python)를 가지며 각 owner는 세 database마다 항목이 있다.
  assert.equal(checkCoverage(selectFeatures(manifest, 'statement_events'), {}).length, 5 * databases.length);
  assert.throws(() => selectFeatures(manifest, 'statement_events', ['owner/cobol']),
    { message: 'unknown coverage part owner/cobol of statement_events; valid parts: owner/go, owner/php, owner/rust, owner/typescript, owner/python' });
  assert.throws(() => selectFeatures(manifest, undefined, ['owner/php']), { message: '--part needs --feature' });
});

caseTest('an unknown feature name fails with the list of valid names', 1000, () => {
  const manifest = { features: [{ id: 'one' }, { id: 'two' }] };
  assert.throws(() => selectFeatures(manifest, 'missing'),
    { message: 'unknown feature missing; valid features: one, two' });
  assert.throws(() => selectFeatures(manifest, ''),
    { message: 'unknown feature ; valid features: one, two' });
});

caseTest('aggregate numeric TypeScript cases are owned by the client', 1000, async () => {
  const root = new URL('../..', import.meta.url);
  const manifest = readFeatures(new URL('../..', import.meta.url).pathname);
  const feature = manifest.features.find(item => item.id === 'model_queries');
  assert.ok(feature?.tests);
  assert.ok(feature.tests.includes('packages/ts/tests/aggregate_numeric.mjs'));
  assert.ok(!feature.tests.includes('tests/typescript/aggregate_numeric.mjs'));
  assert.ok((await stat(new URL('packages/ts/tests/aggregate_numeric.mjs', root))).isFile());
});

caseTest('TypeScript behavior tests stay in their client directory', 1000, async () => {
  const root = new URL('../..', import.meta.url);
  const expected = ['codec-vector', 'dsn', 'engine', 'generate', 'model', 'sqlite-concurrency'];
  const entries = await readdir(new URL('packages/ts/tests/', root));
  for (const name of expected) assert.ok(entries.includes(`${name}.mjs`), `${name}.mjs missing from owner`);
  await assert.rejects(readdir(new URL('tests/typescript/', root)), { code: 'ENOENT' });
});

function contract(kind = 'database'): SampleManifest {
  return { features: [{ id: 'sample', status: 'implemented',
    clients: Object.fromEntries(languages.map(language => [language, 'pass'])),
    coverage: { kind, cases: ['first', 'second'],
      owners: Object.fromEntries(languages.map(language => [language, { part: packageDirectoryOf(language),
        tests: [ownerTests[language] ?? ''], commands: {} }])),
      dependents: [{ id: 'service', language: 'go', part: 'packages/go/model',
        tests: [dependentTest], cases: ['first'], commands: {} }] } }] };
}

function complete(kind = 'database'): Reports {
  const reports: Reports = {};
  const make = (role: string, part: string, tests: string[], language: string, database: string, cases: string[], dependent?: string): Report[] => {
    const report: Report = { feature: 'sample', role, part, tests, language, database, success: true, cases,
      results: cases.map((id, index) => ({ id, database, value_json: String(index + 1) })),
      ...(dependent ? { dependent } : {}),
      ...(kind === 'database' ? { state_before: 'digest', state_after: 'digest' } : {}) };
    return [structuredClone(report), structuredClone(report)];
  };
  for (const language of languages) for (const database of kind === 'database' ? databases : ['none']) {
    reports[`sample/owner/${language}/${database}`] = make('owner', packageDirectoryOf(language), [ownerTests[language] ?? ''], language, database, ['first', 'second']);
    if (language === 'go') reports[`sample/dependent/service/go/${database}`] = make('dependent', 'packages/go/model', [dependentTest], language, database, ['first'], 'service');
  }
  return reports;
}

function mutation(change: (manifest: SampleManifest, reports: Reports) => void, kind = 'database'): string {
  const manifest = contract(kind);
  const reports = complete(kind);
  change(manifest, reports);
  return checkCoverage(manifest, reports).join('\n');
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
async function negative(manifest: Manifest, root: string, timeoutMs: number): Promise<{ errors: string[]; failures: string[] }> {
  const { value, lines } = await quietly(() => executeCoverage(manifest, root, timeoutMs));
  return { errors: value.toSorted(), failures: tapFailures(lines) };
}

caseTest('owner and dependent cases execute in five languages and three databases', 1000, () => {
  assert.deepEqual(checkCoverage(contract(), complete()), []);
  assert.deepEqual(checkCoverage(contract('independent'), complete('independent')), []);
});

caseTest('an implemented feature with Python planned requires no Python owner', 1000, () => {
  assert.deepEqual(mutation((m, r) => {
    m.features[0].clients.python = 'planned';
    delete m.features[0].coverage.owners.python;
    for (const database of databases) delete r[`sample/owner/python/${database}`];
  }), '');
  assert.match(mutation((m) => { m.features[0].clients.python = 'planned'; }), /sample\/owner\/python: undeclared owning client/);
});

caseTest('missing owner, dependent, database, case, and repeat are RED', 1000, () => {
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
  assert.match(mutation((_, r) => { defined(r['sample/owner/typescript/postgres']).pop(); }), /exactly two executions required/);
});

caseTest('identity, result, state, and unknown report mutations are RED', 1000, () => {
  assert.match(mutation((m) => { m.features[0].clients.rust = 'planned'; }), /lacks a passing client/);
  assert.match(mutation((_, r) => { defined(defined(r['sample/owner/go/mysql'])[0]).part = 'packages/php'; }), /report identity differs/);
  assert.match(mutation((_, r) => { defined(defined(r['sample/dependent/service/go/mysql'])[0]).role = 'owner'; }), /report identity differs/);
  assert.match(mutation((_, r) => { defined(defined(r['sample/dependent/service/go/mysql'])[0]).tests = [defined(ownerTests.go)]; }), /executed test paths differ/);
  assert.match(mutation((_, r) => { defined(defined(r['sample/owner/go/mysql'])[0]).success = false; }), /execution failed/);
  assert.match(mutation((_, r) => { defined(defined(r['sample/owner/go/mysql'])[0]).state_after = 'changed'; }), /database state changed/);
  assert.match(mutation((_, r) => { defined(defined(defined(r['sample/owner/go/mysql'])[1]).results[1]).value_json = '9007199254740993'; }), /results changed/);
  assert.match(mutation((_, r) => { defined(defined(defined(r['sample/owner/go/mysql'])[0]).results[1]).id = 'first'; }), /executed case IDs differ/);
  assert.match(mutation((_, r) => { defined(defined(defined(r['sample/owner/go/mysql'])[0]).results[1]).value_json = '{'; }), /executed case IDs differ/);
  assert.match(mutation((_, r) => { r['other/owner/go/mysql'] = defined(r['sample/owner/go/mysql']); }), /undeclared execution report/);
  assert.match(mutation((m) => { m.features[0].coverage.cases = ['first', 'first']; }), /distinct nonempty IDs/);
});

caseTest('native owner and dependent files execute twice from their own parts', 8000, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-')));
  const owner = 'packages/ts/tests/owner.mjs';
  const dependent = 'packages/ts/use/dependent.mjs';
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', clients: { typescript: 'partial' },
    coverage: { kind: 'independent', cases: ['first', 'second'],
      owners: { typescript: { part: 'packages/ts', tests: [owner],
        commands: { none: [{ runner: 'node', test: owner, cases: ['first', 'second'] }] } } },
      dependents: [{ id: 'use', language: 'typescript', part: 'packages/ts/use',
        tests: [dependent], cases: ['first'], commands: { none: [{ runner: 'node', test: dependent, cases: ['first'] }] } }] } }] };
  try {
    await mkdir(join(root, 'packages/ts/tests'), { recursive: true });
    await mkdir(join(root, 'packages/ts/use'), { recursive: true });
    await writeFile(join(root, owner), "for (const id of process.argv.slice(2)) { if (!['first', 'second'].includes(id)) process.exit(2); console.log(`CASE ${id} PASS`); }\n");
    await writeFile(join(root, dependent), "for (const id of process.argv.slice(2)) { if (id !== 'first') process.exit(2); console.log(`CASE ${id} PASS`); }\n");
    assert.deepEqual(await executeCoverage(manifest, root, 1000), []);
    const unexpected = '{"success":true,"cases":["first","second"]}';
    await writeFile(join(root, owner), `process.stdout.write(${JSON.stringify(unexpected)});\n`);
    const missing = 'sample/owner/typescript/none: exactly two executions required';
    assert.deepEqual(await negative(manifest, root, 1000), {
      errors: [`sample/owner/typescript/none run 1: unexpected test output: ${unexpected}`, missing].toSorted(),
      failures: [`not ok - sample/owner/typescript/none run 1\n# unexpected test output: ${unexpected}`],
    });
    await writeFile(join(root, owner), "for (const id of process.argv.slice(2)) { console.log(`CASE ${id} PASS`); console.log(`CASE ${id} PASS`); }\n");
    assert.deepEqual(await negative(manifest, root, 1000), {
      errors: ['sample/owner/typescript/none run 1: duplicate observed case first', missing].toSorted(),
      failures: ['not ok - sample/owner/typescript/none run 1\n# duplicate observed case first'],
    });
    delete defined(defined(manifest.features[0].coverage.dependents[0]).commands).none;
    assert.deepEqual(await negative(manifest, root, 1000), {
      errors: ['sample/dependent/use/typescript/none: no executable command', 'sample/dependent/use/typescript/none: no executed report',
        'sample/owner/typescript/none run 1: duplicate observed case first', missing].toSorted(),
      failures: ['not ok - sample/owner/typescript/none run 1\n# duplicate observed case first'],
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Go test cache가 두 번째 실행을 대신하면 실행 증거가 아니므로, 각 실행이
// test process를 실제로 실행해 directory를 하나씩 남기는지 확인한다.
caseTest('every Go execution runs the test instead of reading the test cache', 120000, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-go-')));
  const owner = 'packages/go/sample/sample_test.go';
  const runs = join(root, 'runs');
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', clients: { go: 'partial' },
    coverage: { kind: 'independent', cases: ['first'],
      owners: { go: { part: 'packages/go/sample', tests: [owner],
        commands: { none: [{ runner: 'go', test: owner, cases: ['first'], symbols: { first: 'TestFirst' } }] } } },
      dependents: [] } }] };
  try {
    await mkdir(join(root, 'packages/go/sample'), { recursive: true });
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

// 느리지만 정상인 build는 기한 없이 끝까지 실행한다. PATH 앞의 go는 1.5초를 쉰 뒤 실제 go를 실행하므로
// test2json build와 test binary build가 각각 1.5초 이상 걸리고, 두 build와 두 실행이 모두 통과한다.
caseTest('a slow but healthy coverage build runs to its end without a deadline', 120000, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-slow-')));
  const owner = 'packages/go/sample/sample_test.go';
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', clients: { go: 'partial' },
    coverage: { kind: 'independent', cases: ['first'],
      owners: { go: { part: 'packages/go/sample', tests: [owner],
        commands: { none: [{ runner: 'go', test: owner, cases: ['first'], symbols: { first: 'TestFirst' } }] } } },
      dependents: [] } }] };
  const path = process.env.PATH;
  try {
    const realGo = execFileSync('sh', ['-c', 'command -v go']).toString().trim();
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(join(root, 'bin/go'), `#!/bin/sh\nsleep 1.5\nexec ${JSON.stringify(realGo)} "$@"\n`);
    await chmod(join(root, 'bin/go'), 0o755);
    await mkdir(join(root, 'packages/go/sample'), { recursive: true });
    await writeFile(join(root, 'go.mod'), 'module sample\n\ngo 1.22\n');
    await writeFile(join(root, owner), '//go:build featurecoverage\n\npackage sample\n\nimport "testing"\n\nfunc TestFirst(t *testing.T) {}\n');
    process.env.PATH = `${join(root, 'bin')}:${path}`;
    const started = performance.now();
    assert.deepEqual(await executeCoverage(manifest, root, 60000), []);
    assert.ok(performance.now() - started >= 3000, 'both builds ran through the slow go');
  } finally {
    process.env.PATH = path;
    await rm(root, { recursive: true, force: true });
  }
});

// phpunitStub writes, under root, a vendor-php/bin/phpunit that stands for PHPUnit: it requires the arguments with
// which coverage.mts runs the test file of a PHP case `first` (the TeamCity output, the package configuration, the anchored
// filter of test_first and the file), runs the PHP code `before`, and writes the TeamCity events `events` to stdout.
async function phpunitStub(root: string, file: string, events: string[], before = ''): Promise<void> {
  const want = ['--teamcity', '--configuration', join(root, 'packages/php/phpunit.xml.dist'), '--filter', '/::(test_first)$/', join(root, file)];
  await mkdir(join(root, 'vendor-php/bin'), { recursive: true });
  await writeFile(join(root, 'vendor-php/bin/phpunit'), `<?php\nif (array_slice($argv, 1) !== ${phpArray(want)}) exit(2);\n${before}echo ${JSON.stringify(events.map((e: string) => `##teamcity[${e} flowId='1']`).join('\n') + '\n')};\n`);
}

function phpArray(list: string[]): string {
  return `[${list.map((item: string) => JSON.stringify(item)).join(', ')}]`;
}

const PASSED = ["testStarted name='test_first'", "testFinished name='test_first' duration='0'"];

// Rust build 겹침 case(G5.123)는 cargo test binary를 쓰지 않는 실행이 Rust build를 기다리지 않는지 본다. PATH 앞의 cargo는
// `cargo test --no-run`에서 FIFO를 읽을 때까지, 곧 PHP case가 그 FIFO에 쓸 때까지 기다린 뒤 실제 cargo를 실행한다. manifest에서
// Rust 소유자가 PHP 소유자보다 앞에 있으므로, build가 끝난 뒤에야 실행을 시작하거나 줄의 순서대로만 실행하면 build와 PHP
// case가 서로를 기다려 case의 기한에 실패한다.
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

caseTest('coverage runs without cargo proceed while the Rust test build runs', 120000, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-overlap-')));
  const rustFile = 'packages/rust/orm/src/lib.rs';
  const phpFile = 'packages/php/tests/OwnerTest.php';
  const fifo = join(root, 'build-gate');
  const written = join(root, 'written');
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', clients: { rust: 'partial', php: 'partial' },
    coverage: { kind: 'independent', cases: ['first'], dependents: [], owners: {
      rust: { part: 'packages/rust/orm', tests: [rustFile], commands: { none: [{ runner: 'cargo', test: rustFile, cases: ['first'], symbols: { first: 'tests::first' } }] } },
      php: { part: 'packages/php/tests', tests: [phpFile], commands: { none: [{ runner: 'php', test: phpFile, cases: ['first'] }] } },
    } } }] };
  const path = process.env.PATH;
  let restoreLease = (): void => {};
  try {
    restoreLease = await exportLease(root);
    const realCargo = execFileSync('sh', ['-c', 'command -v cargo']).toString().trim();
    await mkdir(join(root, 'bin'), { recursive: true });
    execFileSync('mkfifo', [fifo]);
    await writeFile(join(root, 'bin/cargo'), `#!/bin/sh\ncase " $* " in *" test "*"--no-run "*) read gate < ${JSON.stringify(fifo)} ;; esac\nexec ${JSON.stringify(realCargo)} "$@"\n`);
    await chmod(join(root, 'bin/cargo'), 0o755);
    for (const file of [rustFile, phpFile]) await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, 'packages/rust/orm/Cargo.toml'), '[package]\nname = "coverage_overlap"\nversion = "0.0.1"\nedition = "2021"\n');
    await writeFile(join(root, rustFile), '#[cfg(test)] mod tests { #[test] fn first() {} }\n');
    // 첫 실행만 FIFO에 쓴다. 쓰기는 cargo가 FIFO를 읽으려고 열 때까지 기다린다.
    await writeFile(join(root, phpFile), '<?php\n');
    await phpunitStub(root, phpFile, PASSED, `if (!file_exists(${JSON.stringify(written)})) { file_put_contents(${JSON.stringify(fifo)}, "go\\n"); touch(${JSON.stringify(written)}); }\n`);
    process.env.PATH = `${join(root, 'bin')}:${path}`;
    assert.deepEqual(await executeCoverage(manifest, root, 30000), []);
  } finally {
    process.env.PATH = path;
    restoreLease();
    await rm(root, { recursive: true, force: true });
  }
});

caseTest('invented JSON success from an arbitrary command is not execution evidence', 8000, async () => {
  const manifest = contract('independent');
  const report = (role: string, part: string, tests: string[], language: string, cases: string[], dependent?: string) => JSON.stringify({
    feature: 'sample', role, part, tests, language, database: 'none', success: true, cases,
    results: cases.map(id => ({ id, value_json: 'true' })), ...(dependent ? { dependent } : {}),
  });
  for (const language of languages) {
    // @ts-expect-error: a shell command in place of native test commands is the invalid contract under test.
    defined(defined(manifest.features[0].coverage.owners[language]).commands).none =
      `node -e 'process.stdout.write(${JSON.stringify(report('owner', packageDirectoryOf(language), [ownerTests[language] ?? ''], language, ['first', 'second']))})'`;
  }
  // @ts-expect-error: a shell command in place of native test commands is the invalid contract under test.
  defined(defined(manifest.features[0].coverage.dependents[0]).commands).none =
    `node -e 'process.stdout.write(${JSON.stringify(report('dependent', 'packages/go/model', [dependentTest], 'go', ['first'], 'service'))})'`;
  assert.match((await executeCoverage(manifest, new URL('../..', import.meta.url).pathname, 1000)).join('\n'),
    /invalid native test command/);
});

caseTest('checker reads physical database state around each native test run', 120000, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-db-')));
  const owner = 'packages/ts/tests/owner.mjs';
  const databasePath = join(root, 'state.sqlite');
  const dsn = `sqlite://${databasePath}`;
  const previous = process.env.ORM_COVERAGE_TEST_SQLITE_DSN;
  process.env.ORM_COVERAGE_TEST_SQLITE_DSN = dsn;
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', clients: { typescript: 'partial' },
    coverage: { kind: 'database', cases: ['first'], dependents: [], owners: {
      typescript: { part: 'packages/ts', tests: [owner], commands: Object.fromEntries(databases.map(database =>
        [database, [{ runner: 'node', test: owner, cases: ['first'], dsn_env: 'ORM_COVERAGE_TEST_SQLITE_DSN' }]])) },
    } } }] };
  try {
    await mkdir(join(root, 'packages/ts/tests'), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY AUTOINCREMENT, value INTEGER NOT NULL); INSERT INTO state (value) VALUES (1)');
    db.close();
    // One run of the file prints the case of every database of its item list; each item takes its own line.
    await writeFile(join(root, owner), "if (process.argv[2] !== 'first') process.exit(2); for (const database of ['mysql', 'postgres', 'sqlite']) console.log(`CASE first [${database}] PASS`);\n");
    // Exercise only the SQLite slot; the other database declarations are checked separately.
    const feature = manifest.features[0];
    feature.coverage.kind = 'database';
    const original = [...databases];
    assert.deepEqual(original, ['mysql', 'postgres', 'sqlite']);
    const sqliteOnly = 'database state reader: exit 1: check: state DSN scheme "sqlite" differs from database';
    // The file runs once for its three items. A state reader that fails names its own item; the run stops before the file runs,
    // so every item reports the failure and the single group failure line.
    const groupFailure = 'database state reader failed';
    const first = await negative(manifest, root, 30000);
    assert.deepEqual(first, {
      errors: [
        `sample/owner/typescript/mysql run 1: ${sqliteOnly} "mysql"`,
        `sample/owner/typescript/mysql: exactly two executions required`,
        `sample/owner/typescript/postgres run 1: ${sqliteOnly} "postgres"`,
        `sample/owner/typescript/postgres: exactly two executions required`,
        `sample/owner/typescript/sqlite run 1: ${groupFailure}`,
        `sample/owner/typescript/sqlite: exactly two executions required`,
      ].toSorted(),
      failures: [`not ok - sample/owner/typescript/mysql (mysql,postgres,sqlite) run 1\n# ${groupFailure}`],
    });
    await writeFile(join(root, owner), "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(new URL(process.env.ORM_COVERAGE_TEST_SQLITE_DSN).pathname); db.exec('UPDATE state SET value = value + 1'); db.close(); for (const database of ['mysql', 'postgres', 'sqlite']) console.log(`CASE first [${database}] PASS`');\n");
    // The state readers of mysql and postgres refuse the sqlite DSN, so the run never reaches the state comparison; the
    // comparison of a changed state is covered by checkCoverage in the unit tests above.
    const changed = await negative(manifest, root, 30000);
    assert.deepEqual(changed, first);
  } finally {
    if (previous === undefined) delete process.env.ORM_COVERAGE_TEST_SQLITE_DSN;
    else process.env.ORM_COVERAGE_TEST_SQLITE_DSN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

caseTest('Go, PHP, and Rust native cases execute through their owning files', 120000, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-native-')));
  const cases: { language: string; part: string; file: string; runner: string; symbol?: string; id?: string }[] = [
    { language: 'go', part: 'packages/go/orm', file: 'packages/go/orm/owner_test.go', runner: 'go', symbol: 'TestFirst' },
    { language: 'php', part: 'packages/php/tests', file: 'packages/php/tests/OwnerTest.php', runner: 'php', id: 'first' },
    { language: 'rust', part: 'packages/rust/orm', file: 'packages/rust/orm/src/lib.rs', runner: 'cargo', symbol: 'tests::first' },
  ];
  let restoreLease = (): void => {};
  try {
    restoreLease = await exportLease(root);
    for (const item of cases) await mkdir(join(root, item.file, '..'), { recursive: true });
    await writeFile(join(root, 'packages/go/orm/go.mod'), 'module example.com/coverage\n\ngo 1.22\n');
    await writeFile(join(root, defined(cases[0]).file), 'package orm\nimport "testing"\nfunc TestFirst(t *testing.T) {}\n');
    await writeFile(join(root, defined(cases[1]).file), '<?php\n');
    await phpunitStub(root, defined(cases[1]).file, PASSED);
    await writeFile(join(root, 'packages/rust/orm/Cargo.toml'), '[package]\nname = "coverage_probe"\nversion = "0.0.1"\nedition = "2021"\n');
    // cargo test처럼 실행 시점의 CARGO_MANIFEST_DIR가 test file을 소유하는 package directory다.
    await writeFile(join(root, defined(cases[2]).file), '#[cfg(test)] mod tests { #[test] fn first() { ' +
      'assert_eq!(std::env::var("CARGO_MANIFEST_DIR").as_deref(), Ok(env!("CARGO_MANIFEST_DIR"))); } }\n');
    for (const item of cases) {
      const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', clients: { [item.language]: 'partial' },
        coverage: { kind: 'independent', cases: ['first'], dependents: [], owners: {
          [item.language]: { part: item.part, tests: [item.file], commands: {
            none: [{ runner: item.runner, test: item.file, cases: ['first'],
              ...(item.symbol ? { symbols: { first: item.symbol } } : {}) }],
          } },
        } } }] };
      assert.deepEqual(await executeCoverage(manifest, root, 30000), [], item.language);
      if (item.symbol) {
        const command = defined(defined(defined(defined(manifest.features[0].coverage.owners[item.language]).commands).none)[0]);
        const variants: Record<string, string>[] = [{}, { first: item.symbol, extra: 'Unused' }, { first: 'MissingNativeTest' }];
        for (const symbols of variants) {
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
    // 선언된 Rust test file을 compile하는 test binary가 없으면 같은 symbol이 다른 file에 있어도
    // 실행 증거가 아니다.
    const unused = 'packages/rust/orm/src/unused.rs';
    await writeFile(join(root, unused), '#[test] fn first() {}\n');
    const uncompiled: SampleManifest = { features: [{ id: 'sample', status: 'partial', clients: { rust: 'partial' },
      coverage: { kind: 'independent', cases: ['first'], dependents: [], owners: {
        rust: { part: 'packages/rust/orm', tests: [unused], commands: { none: [{ runner: 'cargo', test: unused,
          cases: ['first'], symbols: { first: 'tests::first' } }] } },
      } } }] };
    assert.match((await executeCoverage(uncompiled, root, 30000)).join('\n'), /no test binary compiles .*unused\.rs/);
    // A PHP case is observed only from its clean TeamCity events: a failed or a missing case refuses the run.
    const php = defined(cases[1]);
    const phpManifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', clients: { php: 'partial' },
      coverage: { kind: 'independent', cases: ['first'], dependents: [], owners: {
        php: { part: php.part, tests: [php.file], commands: { none: [{ runner: 'php', test: php.file, cases: ['first'] }] } },
      } } }] };
    const outcomes: [string[], RegExp][] = [
      [["testStarted name='test_first'", "testFailed name='test_first' message='no'", "testFinished name='test_first' duration='0'"], /case test_first did not pass/],
      [["testStarted name='test_first'", "testIgnored name='test_first' message='skipped'", "testFinished name='test_first' duration='0'"], /case test_first did not pass/],
      [[], /observed no cases differ from test_first/],
      [["testFinished name='test_first' duration='0'"], /case test_first finished without starting/],
      [[...PASSED, ...PASSED], /duplicate observed case test_first/],
    ];
    for (const [events, error] of outcomes) {
      await phpunitStub(root, php.file, events);
      assert.match((await quietly(() => executeCoverage(phpManifest, root, 30000))).value.join('\n'), error);
    }
    const go = defined(cases[0]);
    await writeFile(join(root, go.file), 'package orm\nimport "testing"\nfunc TestFirst(t *testing.T) { t.Skip("no executed pass") }\n');
    const skipped: SampleManifest = { features: [{ id: 'sample', status: 'partial', clients: { go: 'partial' },
      coverage: { kind: 'independent', cases: ['first'], dependents: [], owners: {
        go: { part: go.part, tests: [go.file], commands: { none: [{ runner: 'go', test: go.file,
          cases: ['first'], symbols: { first: go.symbol ?? '' } }] } },
      } } }] };
    const message = 'observed no cases differ from TestFirst';
    assert.deepEqual(await negative(skipped, root, 30000), {
      errors: [`sample/owner/go/none run 1: ${message}`, 'sample/owner/go/none: exactly two executions required'].toSorted(),
      failures: [`not ok - sample/owner/go/none run 1\n# ${message}`],
    });
  } finally {
    restoreLease();
    await rm(root, { recursive: true, force: true });
  }
});

// A Python owner runs on the interpreter that make names in ORM_PYTHON, as its module of the test package from the checkout
// root, with its case IDs. The
// interpreter here is a stand-in that checks those arguments, so the checker's part is tested without a Python.
caseTest('Python cases execute on the interpreter of ORM_PYTHON', 8000, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-python-')));
  const owner = 'packages/python/tests/owner.py';
  const interpreter = join(root, 'bin/python');
  const previous = process.env.ORM_PYTHON;
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', clients: { python: 'partial' },
    coverage: { kind: 'independent', cases: ['first'], dependents: [],
      owners: { python: { part: 'packages/python/tests', tests: [owner],
        commands: { none: [{ runner: 'python', test: owner, cases: ['first'] }] } } } } }] };
  try {
    await mkdir(join(root, 'packages/python/tests'), { recursive: true });
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, owner), '');
    await writeFile(interpreter, `#!/bin/sh\n[ "$#" = 3 ] && [ "$1" = -m ] && [ "$2" = packages.python.tests.owner ] && [ "$3" = first ] && [ "$PWD" = ${JSON.stringify(root)} ] || exit 2\necho 'CASE first PASS'\n`);
    await chmod(interpreter, 0o755);
    process.env.ORM_PYTHON = interpreter;
    assert.deepEqual(await executeCoverage(manifest, root, 4000), []);
    defined(defined(defined(defined(manifest.features[0].coverage.owners.python).commands).none)[0]).runner = 'node';
    assert.match((await executeCoverage(manifest, root, 4000)).join('\n'), /invalid native test command/);
    defined(defined(defined(defined(manifest.features[0].coverage.owners.python).commands).none)[0]).runner = 'python';
    delete process.env.ORM_PYTHON;
    assert.match((await executeCoverage(manifest, root, 4000)).join('\n'), /ORM_PYTHON is unset; run this through make, which exports it/);
  } finally {
    if (previous === undefined) delete process.env.ORM_PYTHON;
    else process.env.ORM_PYTHON = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// executeCoverage writes each run's native command as one line, then its result as a TAP line (`ok - <case>` or
// `not ok - <case>`). A failed run gives its reason on `# <reason>` lines.
caseTest('every native run reports its command and TAP result', 8000, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orm-feature-report-')));
  const owner = 'packages/ts/tests/owner.mjs';
  const manifest: SampleManifest = { features: [{ id: 'sample', status: 'partial', clients: { typescript: 'partial' },
    coverage: { kind: 'independent', cases: ['first'], dependents: [],
      owners: { typescript: { part: 'packages/ts', tests: [owner],
        commands: { none: [{ runner: 'node', test: owner, cases: ['first'] }] } } } } }] };
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await mkdir(join(root, 'packages/ts/tests'), { recursive: true });
    await writeFile(join(root, owner), "console.log('CASE first PASS');\n");
    assert.deepEqual(await executeCoverage(manifest, root, 1000), []);
    await writeFile(join(root, owner), 'process.exit(3);\n');
    assert.match((await executeCoverage(manifest, root, 1000)).join('\n'), /run 1: exit 3/);
  } finally {
    console.log = log;
    await rm(root, { recursive: true, force: true });
  }
  const expected = [
    `^node ${owner}$`,
    '^ok - sample/owner/typescript/none run 1$',
    `^node ${owner}$`,
    '^ok - sample/owner/typescript/none run 2$',
    `^node ${owner}$`,
    '^not ok - sample/owner/typescript/none run 1$',
    '^# exit 3: $',
  ];
  assert.equal(lines.length, expected.length, lines.join('\n'));
  lines.forEach((line, index) => assert.match(line, new RegExp(expected[index] ?? ''), lines.join('\n')));
});

// The deadline of one native process of a coverage run is an outer bound against a hung process; each test bounds its own
// work by the class it declares (testcase.Start, caseTest), the longest of which is PROCESS. A shorter outer bound stops a
// test inside its own deadline, as it stopped the Go model_generation case (testcase.Process) after 120000 ms (T185).
caseTest('a coverage process deadline is not shorter than the longest declared test class', COMPUTE, () => {
  assert.ok(NATIVE_DEADLINE >= PROCESS, `NATIVE_DEADLINE ${NATIVE_DEADLINE} ms is shorter than PROCESS ${PROCESS} ms`);
});

// A file of database items prints `CASE <id> [<database>] PASS` for its own database; a line of another listed database belongs
// to that item's run, and a line without the database or of an unlisted database is refused.
caseTest('database items take their own [database] lines and refuse plain or unlisted lines', COMPUTE, () => {
  const listed = ['mysql', 'postgres', 'sqlite'];
  const lines = 'CASE first [sqlite] PASS\nCASE first [mysql] PASS\nCASE second [sqlite] PASS\nCASE second [mysql] PASS\n';
  assert.deepEqual(observedCases('case', lines, ['first', 'second'], ['first', 'second'], 'sqlite', listed),
    [{ id: 'first', database: 'sqlite', value_json: 'true' }, { id: 'second', database: 'sqlite', value_json: 'true' }]);
  assert.throws(() => observedCases('case', 'CASE first PASS\n', ['first'], ['first'], 'sqlite', listed), /unexpected test output: CASE first PASS/);
  assert.throws(() => observedCases('case', 'CASE first [oracle] PASS\n', ['first'], ['first'], 'sqlite', listed), /is not an item of this file/);
  assert.throws(() => observedCases('case', 'CASE first [sqlite] PASS\nCASE first [sqlite] PASS\n', ['first'], ['first'], 'sqlite', listed), /duplicate observed case first on sqlite/);
  assert.throws(() => observedCases('case', 'CASE first [sqlite] PASS\n', ['first', 'second'], ['first', 'second'], 'sqlite', listed), /differ/);
  assert.deepEqual(observedCases('case', 'CASE first PASS\n', ['first'], ['first'], 'none', ['none']), [{ id: 'first', database: 'none', value_json: 'true' }]);
  assert.throws(() => observedCases('case', 'CASE first [sqlite] PASS\n', ['first'], ['first'], 'none', ['none']), /unexpected test output/);
});
