// Checks the runner (scripts/check/run.mts) and its run record (scripts/check/record.mts) with stub steps. Each case, in a temporary git
// checkout, runs runChecks in its own process, with stub commands in place of database creation and removal and of make targets, which log their own names.
// The real targets and databases are not run. The full suite's guard is a tool of @polyspec/kit.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';
import { readRecord, summarize, type CheckRecord } from './record.mts';
import type { StepRecord } from './report.mts';
import { errorMessage } from '../../tests/errors.mts';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
// caseTest does not give a node:test context, so the temporary directory is removed by the cleanup at the end of the case.
const after: (() => void)[] = [];
function cleanup() {
  for (let f = after.pop(); f; f = after.pop()) f();
}
// scope hands the checkout's temporary directory to the cleanup at the end of the case.
// named is one target of the record. If it is missing, the case fails.
function named(record: CheckRecord, name: string): StepRecord {
  const found = record.targets.find(target => target.name === name);
  assert.ok(found, `the record has no target ${name}`);
  return found;
}
const scope = { after: (f: () => void) => { after.push(f); } };

// stub runs runChecks with stub commands. The database command (node scripts/check/databases.mts) logs `databases <action>`, and a make target logs its own
// name. `b` passes only when an untracked file `pass-b` is present, so the case changes results
// without changing the tree. Giving kill a target name makes that target end the runner process with SIGKILL.
//
// STUB_SUITE=failing is the suite for the setup-failure case: among targets a, b, c, d, a and c need a database, and the database
// creation fails; b prints one failed case and one unfinished case and leaves a run directory, and d passes.
const STUB = `import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { handleCrashes, runChecks } from ${JSON.stringify(resolve(repo, 'scripts/check/run.mts'))};
const [root, log, kill, servers] = process.argv.slice(2);
const failing = process.env.STUB_SUITE === 'failing';
// STUB_SUITE=lost는 target b가 실행 도중 보고서 directory를 지우고 출력을 더 쓰는 suite, STUB_SUITE=throws는 target b가
// runner의 콜백 밖에서 처리되지 않는 오류를 던지는 suite다(G5.43-1).
const lost = process.env.STUB_SUITE === 'lost';
const throws = process.env.STUB_SUITE === 'throws';
// STUB_SUITE=drop은 database 지우기가 databases.mts처럼 받은 directory를 통째로 지우는 suite, STUB_SUITE=verbose는 target b가
// 3 MiB를 출력하는 suite다(G5.43-2).
const drop = process.env.STUB_SUITE === 'drop';
const verbose = process.env.STUB_SUITE === 'verbose';
// STUB_SUITE=space는 target b가 /tmp의 quota 초과로 실패하는 suite다(G5.43-4).
const space = process.env.STUB_SUITE === 'space';
// STUB_SUITE=diskio-full와 diskio-free는 target b가 SQLite의 disk I/O error로 실패하는 suite다. full은 그 순간 /tmp의
// 남은 공간이 0이고 지웠지만 열린 큰 file이 있는 기록, free는 공간이 남은 기록이다. STUB_SUITE=npm은 target b가 npm처럼
// 보고서 밖의 debug log(STUB_NPM_LOG)만 가리키고 실패하는 suite다(G5.44).
const diskio = process.env.STUB_SUITE?.startsWith('diskio-');
const npm = process.env.STUB_SUITE === 'npm';
// STUB_SUITE=cisetup은 CI setup step rust가 실패한 실행이다(G5.52): a는 rust가, c는 go가 필요하고 b는 아무것도 필요하지 않다.
const cisetup = process.env.STUB_SUITE === 'cisetup';
// STUB_SUITE=server-programs는 CI group이 setup step server-programs를 건너뛴 실행이다(G5.127): a와 c는 databases만 선언하고,
// servers와 databases/create가 server-programs의 program을 쓰므로 그것도 server-programs가 필요하다.
const serverPrograms = process.env.STUB_SUITE === 'server-programs';
// STUB_SUITE=group과 group-rust는 CI group의 job이다(G5.111): group-needs가 rust, php와 server의 setup step을 건너뛰게
// 했고, 어느 target도 database가 필요하지 않다. group에서는 c만 go가 필요하고, group-rust에서는 a가 건너뛴 rust도 필요하다.
const group = process.env.STUB_SUITE === 'group';
const groupRust = process.env.STUB_SUITE === 'group-rust';
const skipped = { checkout: { outcome: 'success' }, node: { outcome: 'success' }, 'group-needs': { outcome: 'success' }, go: { outcome: 'success' },
  rust: { outcome: 'skipped' }, 'rust-cache': { outcome: 'skipped' }, php: { outcome: 'skipped' }, composer: { outcome: 'skipped' },
  'server-programs': { outcome: 'skipped' }, servers: { outcome: 'skipped' } };
handleCrashes();
const run = async (program, args, step, spawned = () => {}) => {
  const name = args[1] === 'databases-create' ? 'databases create' : args[0] === 'scripts/check/databases.mts' ? \`databases \${args[1]}\` : args.at(-1);
  appendFileSync(log, name + '\\n');
  if (kill && name === kill) process.kill(process.pid, 'SIGKILL');
  if (failing && name === 'databases create') {
    step('databases: CREATE DATABASE orm_check_x_bench failed: ERROR 1045 (28000): Access denied for user');
    throw new Error('node scripts/check/databases.mts create exited with 1');
  }
  if (failing && name === 'b') {
    spawned(4242);
    const dir = root + '/.runtime/run/b-4242';
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + '/out.json', '{"rows": 5}\\n');
    writeFileSync(dir + '/big.log', 'x'.repeat(2 * 1024 * 1024) + 'END\\n');
    for (const line of ['RUN b/count deadline=1m0s', 'STEP b/count elapsed=1ms: SELECT COUNT(*) FROM t', 'FAIL b/count elapsed=2ms: rows of t: expected 3, actual 5',
      'RUN b/pending deadline=1m0s', 'STEP b/pending elapsed=1ms: waiting for the lock of t'])
      step(line);
    throw new Error('make --no-print-directory -k b exited with 2');
  }
  if (drop && name === 'databases drop') rmSync(args[3], { recursive: true, force: true });
  if (space && name === 'b') {
    step('STEP fuzz/engine-ir elapsed=33ms: write /tmp/go-build3971832083/b001/_testmain.go: disk quota exceeded');
    throw new Error('make --no-print-directory -k b exited with 2');
  }
  if (diskio && name === 'b') {
    step('[rust] FAIL audit_record_transaction elapsed=29ms: install: DRIVER: disk I/O error');
    throw new Error('make --no-print-directory -k b exited with 2');
  }
  if (npm && name === 'b') {
    writeFileSync(process.env.STUB_NPM_LOG, '0 verbose cli /usr/bin/node /usr/bin/npm\\n12 error code E404\\n13 error 404 Not Found - GET https://registry.npmjs.org/x - Not found\\n14 verbose exit 1\\n');
    step('STEP package elapsed=679ms: npm error A complete log of this run can be found in: ' + process.env.STUB_NPM_LOG);
    throw new Error('make --no-print-directory -k b exited with 2');
  }
  if (verbose && name === 'b') {
    for (let i = 0; i < 3 * 1024; i++) step(\`line \${i} \${'v'.repeat(1000)}\`);
    return;
  }
  if (lost && name === 'b') {
    rmSync(root + '/.runtime/check/' + process.env.STUB_REPORT_RUN + '/report', { recursive: true, force: true });
    step('a line after the report directory is gone');
    return;
  }
  if (throws && name === 'b') {
    await new Promise(() => setImmediate(() => { throw new Error('boom outside the runner'); }));
  }
  if (!failing && !lost && !throws && !verbose && !space && !diskio && !npm && !cisetup && !serverPrograms && !group && !groupRust && name === 'b' && !existsSync(root + '/pass-b')) throw new Error('make b exited with 2');
};
const targets = failing ? ['a', 'b', 'c', 'd'] : ['a', 'b', 'c'];
const needs = cisetup || groupRust ? { a: ['rust'], b: [], c: ['go'] } : group ? { a: [], b: [], c: ['go'] } : { a: ['databases'], b: [], c: ['databases'], d: [] };
// 공간 기록은 공간 case에서만 실제 diskSnapshot이다. 다른 case는 /tmp를 읽지 않는 고정 기록을 쓴다.
const removed = '## files under /tmp that were removed but are still open (lsof +L1)\\nCOMMAND PID USER FD TYPE DEVICE SIZE/OFF NLINK NODE NAME\\nmysqld 10079 runner 2w REG 0,38 6493765632 0 3807 /tmp/orm-binlog-AHN00Q/mysqld.log (deleted)\\n';
const snapshot = space ? undefined
  : process.env.STUB_SUITE === 'diskio-full' ? () => ({ text: '## df -k / /tmp\\nstub\\n' + removed, places: { '/': 1, '/tmp': 0 } })
  : () => ({ text: '## df -k / /tmp\\nstub\\n', places: { '/': 1, '/tmp': 1 } });
process.exitCode = await runChecks({ root, servers, targets, run, needs, snapshot, downloads: () => [], ciSetup: serverPrograms ? JSON.stringify({ checkout: { outcome: 'success' }, go: { outcome: 'success' }, 'server-programs': { outcome: 'skipped' } }) : cisetup ? JSON.stringify({ checkout: { outcome: 'success' }, go: { outcome: 'success' }, rust: { outcome: 'failure' }, 'rust-cache': { outcome: 'failure' } }) : group || groupRust ? JSON.stringify(skipped) : '' });
`;

function checkout(t: { after: (f: () => void) => void }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'run-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'checkout');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.gitignore'), '/.runtime/\npass-b\n');
  writeFileSync(join(base, 'stub.mjs'), STUB);
  const servers = join(base, 'servers.env');
  writeFileSync(servers, "export ORM_TEST_MYSQL_DSN='mysql://root@127.0.0.1:1/orm_test'\n");
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init');
  const log = join(base, 'ran.log');
  return {
    root,
    git,
    servers,
    run: (kill = '', env: Record<string, string> = {}) => spawnSync(process.execPath, [join(base, 'stub.mjs'), root, log, kill, servers], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: isolatedEnvironment(env) }),
    ran: () => {
      const names = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
      rmSync(log, { force: true });
      return names;
    },
    // record is the record of the only run of this checkout (.runtime/check/<run id>/record.json).
    record: (): CheckRecord => {
      const runs = readdirSync(join(root, '.runtime/check'));
      assert.equal(runs.length, 1, `runs of the checkout: ${runs.join(', ')}`);
      return readRecord(join(root, '.runtime/check', runs[0] ?? '', 'record.json'));
    },
  };
}

// recipe returns the target's command lines from the Makefile.
function recipe(target: string): string[] {
  const lines = readFileSync(resolve(repo, 'Makefile'), 'utf8').split('\n');
  const body: string[] = [];
  for (const line of lines.slice(lines.findIndex(line => line.startsWith(`${target}:`) && !line.startsWith(`${target}:=`)) + 1)) {
    if (!line.startsWith('\t')) break;
    body.push(line.trim());
  }
  return body;
}

// The check case checks that make orm-check runs target check-run through the kit guard (the full-run tool of @polyspec/kit) and that make check-run runs
// the runner. The first two lines of check-run are a make function that checks GROUP and has no command: without GROUP they expand to an empty line, and a GROUP that does not match
// or a GROUP outside GitHub Actions stops make before any command (G5.111). `make -n check-run` runs with only the variables the case provides
// as its environment (tests/environment.mts), so even when a CI group's job runs this case, that GROUP and GITHUB_ACTIONS do not reach it
// (G5.119).
caseTest('make orm-check starts the kit guard and make check-run starts the runner', COMPUTE, () => {
  assert.deepEqual(recipe('orm-check'), ['$(NODE) $(KIT)/full-run.$(KIT_EXT) run check-run']);
  const run = recipe('check-run');
  assert.ok(run.slice(0, 2).every(line => line.startsWith('$(if $(GROUP),') && line.endsWith(')')), run.join('\n'));
  assert.deepEqual(run.slice(2), ['$(BUILD_LEASE) && $(NODE) scripts/check/run.mts $(abspath $(TEST_ENV)) $(CHECK_RUN_TARGETS)']);
  const dry = (variables: Record<string, string>) => spawnSync('make', ['-n', '--no-print-directory', 'check-run'], { cwd: repo, encoding: 'utf8', env: isolatedEnvironment(variables) });
  for (const variables of [{}, { GROUP: 'static', GITHUB_ACTIONS: 'true' }]) {
    const result = dry(variables);
    assert.equal(result.status, 0, `${JSON.stringify(variables)}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /node scripts\/check\/run\.mts /, `${JSON.stringify(variables)}: ${result.stdout}`);
  }
  const local = dry({ GROUP: 'static' });
  assert.notEqual(local.status, 0, local.stdout);
  assert.match(local.stderr, /GROUP runs one CI group of make check-run on GitHub Actions only; run make orm-check without GROUP/);
  const unknown = dry({ GROUP: 'nope', GITHUB_ACTIONS: 'true' });
  assert.notEqual(unknown.status, 0, unknown.stdout);
  assert.match(unknown.stderr, /GROUP nope names no CI group; give one of CI_GROUPS:/);
});

caseTest('a run records its setup steps and its targets', PROCESS, () => {
  const c = checkout(scope);
  try {
    const result = c.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(c.ran(), ['databases create', 'a', 'b', 'c', 'databases drop']);
    const record = c.record();
    assert.deepEqual([record.result, record.failed], ['failed', ['b']]);
    assert.deepEqual(record.setup.map(step => [step.name, step.status]), [['downloads', 'passed'], ['servers', 'passed'], ['databases/create', 'passed'], ['databases/drop', 'passed']]);
    assert.equal(record.tree, c.git('rev-parse', 'HEAD^{tree}').trim());
  } finally {
    cleanup();
  }
});

caseTest('a killed run stays recorded as incomplete', PROCESS, () => {
  const c = checkout(scope);
  try {
    const result = c.run('a');
    assert.equal(result.signal, 'SIGKILL');
    const record = c.record();
    assert.equal(record.result, 'incomplete');
    assert.deepEqual(record.targets.map(target => [target.name, target.status]), [['a', 'running'], ['b', 'pending'], ['c', 'pending']]);
  } finally {
    cleanup();
  }
});

// The list case checks that the record of a forcibly terminated run separates failed targets from unfinished targets. `a` passes and `b`
// fails, and `c` ends the runner.
caseTest('a killed run records failed and unfinished targets apart', PROCESS, () => {
  const c = checkout(scope);
  try {
    const result = c.run('c');
    assert.equal(result.signal, 'SIGKILL');
    const record = c.record();
    assert.deepEqual([record.result, record.failed, record.incomplete], ['incomplete', ['b'], ['c']]);
    assert.deepEqual(record.targets.map(target => [target.name, target.status]), [['a', 'passed'], ['b', 'failed'], ['c', 'running']]);
  } finally {
    cleanup();
  }
});

caseTest('summarize separates failed from unfinished targets', COMPUTE, () => {
  const record = summarize({ id: 'summary', tree: '', commit: '', started: '', ended: null, result: 'running', failed: [], incomplete: [], setup: [], targets: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'failed' }, { name: 'c', status: 'running' }, { name: 'd', status: 'pending' }] });
  assert.deepEqual([record.failed, record.incomplete], [['b'], ['c', 'd']]);
});

// The setup-failure case (G5.38-1) is a suite of four targets for which creating the database fails: a and c, which need the database, are not-run, with that step and its first
// failure line as the reason, while b and d, which do not need it, run. b fails, and the report contains its exact command and output, and the failed case's
// expected and actual values, the unfinished case and its last step, and the run directory b left (only the end of files over LIMIT_BYTES),
// and the run exits with 1. The CI summary step writes the summary of the same run id to GITHUB_STEP_SUMMARY.
caseTest('a failed setup step blocks only the targets that need it, and the report explains every failure', PROCESS, async ({ step }) => {
  const c = checkout(scope);
  try {
    const stepSummary = join(c.root, '..', 'step-summary.md');
    const env = { STUB_SUITE: 'failing', ORM_CHECK_RUN_ID: '1234-1', GITHUB_STEP_SUMMARY: stepSummary };
    const result = c.run('', env);
    step(`exit ${result.status}`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(c.ran(), ['databases create', 'b', 'd', 'databases drop']);
    const record = c.record();
    const status = (name: string) => named(record, name);
    assert.deepEqual(record.targets.map(target => [target.name, target.status]), [['a', 'not-run'], ['b', 'failed'], ['c', 'not-run'], ['d', 'passed']]);
    for (const name of ['a', 'c'])
      assert.match(status(name).reason ?? '', /^the setup step databases\/create failed: .*Access denied for user/);
    assert.deepEqual(status('b').failures?.slice(0, 2), [
      'FAIL b/count elapsed=2ms: rows of t: expected 3, actual 5',
      'case b/pending did not finish; its last step: STEP b/pending elapsed=1ms: waiting for the lock of t',
    ]);
    const report = join(c.root, '.runtime/check/ci_1234_1/report');
    assert.equal(record.id, 'ci_1234_1');
    const log = readFileSync(join(report, 'targets/b.log'), 'utf8');
    assert.match(log, /^target b\ncommand: make --no-print-directory -k TEST_ENV=\S+ DECIMAL_ENV=\S+ b\n/);
    assert.match(log, /FAIL b\/count elapsed=2ms: rows of t: expected 3, actual 5/);
    assert.match(readFileSync(join(report, 'environment.txt'), 'utf8'), /^commit [0-9a-f]{40}\ntree [0-9a-f]{40}\nos .*\nnode v/);
    const kept = join(report, 'targets/b/run/b-4242');
    // The run directory is deleted after it is copied into the report.
    assert.equal(existsSync(join(c.root, '.runtime/run/b-4242')), false);
    assert.equal(readFileSync(join(kept, 'out.json'), 'utf8'), '{"rows": 5}\n');
    assert.match(readFileSync(join(kept, 'big.log'), 'utf8'), /^\[the last 262144 of 2097156 bytes of .*big\.log\]\nx+END\n$/);
    assert.match(readFileSync(join(kept, 'MANIFEST.txt'), 'utf8'), /big\.log kept as its last 262144 of 2097156 bytes/);
    const summaryText = readFileSync(join(report, 'summary.md'), 'utf8');
    for (const row of [/\| servers \| passed \|/, /\| databases\/create \| failed \|/, /\| a \| not-run \| {2}\| the setup step databases\/create failed/, /\| b \| failed \|/, /\| d \| passed \|/])
      assert.match(summaryText, row);
    assert.match(summaryText, /keeps only its last 262144 bytes/);
    // The CI summary step writes the summary of the same run id to GITHUB_STEP_SUMMARY.
    process.env.GITHUB_STEP_SUMMARY = stepSummary;
    const { runSummary } = await import('./summary.mts');
    const published = runSummary(c.root, '1234-1');
    delete process.env.GITHUB_STEP_SUMMARY;
    assert.equal(published.passed, false);
    assert.match(readFileSync(stepSummary, 'utf8'), /\| b \| failed \|/);
  } finally {
    cleanup();
  }
});

// The crash case (G5.38-1) is a run in which the runner dies at target c. The summary step writes that the runner did not finish, and the report
// directory holds the records up to that point and the target logs.
caseTest('the summary step reports a runner that did not finish, with the partial record', PROCESS, async () => {
  const c = checkout(scope);
  try {
    const stepSummary = join(c.root, '..', 'step-summary.md');
    const result = c.run('c', { ORM_CHECK_RUN_ID: '99-2', GITHUB_STEP_SUMMARY: stepSummary });
    assert.equal(result.signal, 'SIGKILL');
    process.env.GITHUB_STEP_SUMMARY = stepSummary;
    const { runSummary } = await import('./summary.mts');
    const { text, passed } = runSummary(c.root, '99-2');
    delete process.env.GITHUB_STEP_SUMMARY;
    assert.equal(passed, false);
    assert.match(text, /result \*\*crashed\*\*/);
    assert.match(text, /The runner did not finish: the runner process ended without recording the end of run ci_99_2/);
    assert.match(text, /\| b \| failed \|/);
    assert.match(text, /\| c \| running \|/);
    assert.equal(readFileSync(stepSummary, 'utf8'), text);
    assert.equal(readFileSync(join(c.root, '.runtime/check/ci_99_2/report/summary.md'), 'utf8'), text);
    assert.ok(existsSync(join(c.root, '.runtime/check/ci_99_2/report/targets/b.log')));
    const missing = runSummary(c.root, '77-1');
    assert.match(missing.text, /make check-run recorded no run ci_77_1/);
  } finally {
    cleanup();
  }
});

// The recipe-parts case (G5.38-2) checks whether a target whose commands do not read each other's results has a sub-target (part) for each command,
// and it is confirmed. The runner runs targets with `make -k`, so later parts run even when an earlier part fails. A setup part (lease, build)
// a part that depends on it has the setup part as its prerequisite.
const PARTS = {
  'version-check': ['unit', 'run'], 'repo-check': ['unit', 'run'],
  'testcase-check': ['go', 'node', 'runners', 'rust'], 'ts-check': ['hold', 'types', 'test'],
  'rust-check': ['check', 'clippy', 'clippy-live-db', 'clippy-test-faults'], 'rust-fmt-check': ['clients', 'bench', 'interfaces'],
  'fuzz-check': ['engine-ir', 'clients-go-orm'], 'dialect-facts-check': ['probes', 'facts'], 'feature-unit-check': ['docs', 'coverage', 'owners', 'select'],
  'client-unit-check': ['dsn', 'markdown', 'relation-keys', 'hostcodec', 'codec-aes', 'engine', 'runtime-model', 'orm-gen', 'model-methods', 'orm-gen-scan', 'orm-gen-scan-parity', 'client-generics', 'perf-extensions'],
};

caseTest('a target of independent commands runs each as a part of its own', COMPUTE, () => {
  const lines = readFileSync(resolve(repo, 'Makefile'), 'utf8').split('\n');
  const problems = [];
  for (const [target, parts] of Object.entries(PARTS)) {
    const head = lines.find(line => line.startsWith(`${target}:`));
    const want = parts.map(part => `${target}/${part}`);
    if (head?.slice(target.length + 1).trim().split(/\s+/).join(' ') !== want.join(' ')) problems.push(`${target}: prerequisites ${head} instead of ${want.join(' ')}`);
    for (const part of want) if (!recipe(part).length) problems.push(`${part}: no recipe`);
    if (recipe(target).length) problems.push(`${target}: commands of its own besides its parts: ${recipe(target).join(' | ')}`);
  }
  assert.deepEqual(problems, []);
});

// The make -k case puts the real definition of version-check into a temporary Makefile, with $(NODE) pointing at a node that fails in the first part, and runs the runner's
// command `make -k version-check`. The second part runs, and make ends with a failure.
caseTest('the parts of a target after a failed part still run under make -k', PROCESS, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'parts-')));
  try {
    const lines = readFileSync(resolve(repo, 'Makefile'), 'utf8').split('\n');
    const definition = [];
    for (const target of ['version-check', 'version-check/unit', 'version-check/run']) {
      const at = lines.findIndex(line => line.startsWith(`${target}:`));
      if (at < 0) continue;
      definition.push(lines[at], ...recipe(target).map(line => `\t${line}`));
    }
    // The recipes start node as $(NODE) of kit.mk (K171), which the temporary Makefile points at the failing node.
    writeFileSync(join(base, 'Makefile'), `NODE := ${join(base, 'bin/node')}\n${definition.join('\n')}\n`);
    mkdirSync(join(base, 'bin'));
    const log = join(base, 'ran.log');
    writeFileSync(join(base, 'bin/node'), `#!/bin/sh\necho "$*" >> ${log}\ncase "$*" in *check.test.mts*) echo 'FAIL version unit: expected 0, actual 1'; exit 1;; esac\n`, { mode: 0o755 });
    const { command } = await import('./run.mts');
    const lines2 = [];
    const previous = process.env.PATH;
    process.env.PATH = `${join(base, 'bin')}:${previous}`;
    let failure = null;
    try {
      await command(base)('make', ['--no-print-directory', '-k', 'version-check'], (line: string) => lines2.push(line));
    } catch (error) {
      failure = error;
    } finally {
      process.env.PATH = previous;
    }
    assert.match(errorMessage(failure), /make --no-print-directory -k version-check exited with 2/);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['--test scripts/version/check.test.mts', 'scripts/version/check.mts']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The report case (G5.38-4) checks that the CI summary step puts the record and the test server logs into that run's report. The upload
// step uploads only that report directory, so this is the artifact. Logs larger than 1 MiB keep only their end, and the data directory is not included.
caseTest('the summary step keeps the record and the server logs in the report of the run', PROCESS, async () => {
  const c = checkout(scope);
  try {
    assert.equal(c.run('', { STUB_SUITE: 'failing', ORM_CHECK_RUN_ID: '555-1' }).status, 1);
    const servers = join(c.root, '..', 'servers');
    mkdirSync(join(servers, 'mysql'), { recursive: true });
    writeFileSync(join(servers, 'mysql', 'ibdata1'), 'data');
    writeFileSync(join(servers, 'postgres.log'), 'FATAL:  role "orm" does not exist\n');
    writeFileSync(join(servers, 'mysql.log'), `${'y'.repeat(2 * 1024 * 1024)}[ERROR] Aborting\n`);
    const { runSummary } = await import('./summary.mts');
    runSummary(c.root, '555-1', servers);
    const report = join(c.root, '.runtime/check/ci_555_1/report');
    assert.deepEqual(JSON.parse(readFileSync(join(report, 'record.json'), 'utf8')), c.record());
    assert.equal(readFileSync(join(report, 'servers/postgres.log'), 'utf8'), 'FATAL:  role "orm" does not exist\n');
    assert.match(readFileSync(join(report, 'servers/mysql.log'), 'utf8'), /^\[the last 262144 of 2097169 bytes of .*mysql\.log\]\ny+\[ERROR\] Aborting\n$/);
    assert.equal(existsSync(join(report, 'servers/mysql')), false);
  } finally {
    cleanup();
  }
});

// The report-write case (G5.43-1) is a run in which target b deletes the report directory during the run. The runner does not die and runs to the end
// and records `report write failed` in b's record, and exits with 1.
caseTest('a report write that fails is recorded and does not stop the runner', PROCESS, () => {
  const c = checkout(scope);
  try {
    const result = c.run('', { STUB_SUITE: 'lost', ORM_CHECK_RUN_ID: '7-1', STUB_REPORT_RUN: 'ci_7_1' });
    assert.equal(result.signal, null, result.stdout + result.stderr);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(c.ran(), ['databases create', 'a', 'b', 'c', 'databases drop']);
    const record = c.record();
    assert.equal(record.result, 'failed');
    const b = named(record, 'b');
    assert.equal(b.status, 'passed');
    assert.match(b.reportErrors?.[0] ?? '', /^report write failed: .*\/report\/targets\/b\.log: ENOENT: /);
    assert.equal(named(record, 'c').status, 'passed');
    assert.match(result.stdout, /report or record write\(s\) failed:\nreport write failed: .*b\.log: ENOENT/);
  } finally {
    cleanup();
  }
});

// The crash case (G5.43-1) is a run in which target b throws an error not handled outside the runner. The runner records that error as `runner
// error: <stack>`, records the run as crashed, and exits with 1.
caseTest('an unhandled error of the runner is recorded as the reason of a crashed run', PROCESS, async () => {
  const c = checkout(scope);
  try {
    const result = c.run('', { STUB_SUITE: 'throws', ORM_CHECK_RUN_ID: '8-1' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const record = c.record();
    assert.equal(record.result, 'crashed');
    assert.match(record.reason ?? '', /^runner error: Error: boom outside the runner\n {4}at /);
    const { runSummary } = await import('./summary.mts');
    const { text } = runSummary(c.root, '8-1');
    assert.match(text, /The runner did not finish: runner error: Error: boom outside the runner/);
  } finally {
    cleanup();
  }
});

// The report-location case (G5.43-2) is a run in which removing the database deletes the whole received directory, as databases.mts drop does. The report
// is outside that directory, so environment.txt and the logs of all steps remain, and there are no write failures.
caseTest('removing the run databases leaves the report of the run', PROCESS, () => {
  const c = checkout(scope);
  try {
    writeFileSync(join(c.root, 'pass-b'), '');
    const result = c.run('', { STUB_SUITE: 'drop', ORM_CHECK_RUN_ID: '9-1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const run = join(c.root, '.runtime/check/ci_9_1');
    assert.equal(existsSync(join(run, 'databases')), false);
    for (const file of ['environment.txt', 'summary.md', 'targets/servers.log', 'targets/databases-create.log', 'targets/a.log', 'targets/b.log', 'targets/c.log', 'targets/databases-drop.log'])
      assert.ok(existsSync(join(run, 'report', file)), `report/${file} is missing`);
    const record = c.record();
    assert.deepEqual([record.result, record.reportErrors, record.targets.filter(target => target.reportErrors)], ['passed', undefined, []]);
  } finally {
    cleanup();
  }
});

// The log-size case (G5.43-2) is a run in which target b prints 3 MiB. Even during the run, the log keeps only the first 1 MiB and the last 256 KiB,
// and has the head (the command), the last line, and the number of bytes omitted.
caseTest('a target log keeps its head and its tail within the size limit', PROCESS, () => {
  const c = checkout(scope);
  try {
    assert.equal(c.run('', { STUB_SUITE: 'verbose', ORM_CHECK_RUN_ID: '10-1' }).status, 0);
    const log = readFileSync(join(c.root, '.runtime/check/ci_10_1/report/targets/b.log'), 'utf8');
    assert.match(log, /^target b\ncommand: make --no-print-directory -k /);
    assert.match(log, /\nline 0 v+\n/);
    assert.match(log, /\n\[\.\.\. \d+ bytes of output omitted; the last \d+ bytes follow \.\.\.\]\n/);
    assert.match(log, /\nline 3071 v+\nfree space after the step \(KiB\): \{[^\n]*\}\n$/);
    assert.ok(Buffer.byteLength(log) <= 1024 * 1024 + 256 * 1024 + 2048, `the log has ${Buffer.byteLength(log)} bytes`);
    assert.equal((named(c.record(), 'b').truncated ?? 0) > 0, true);
  } finally {
    cleanup();
  }
});

// The first-failure-line case (G5.43-3) reads the end of the client-db-check output from the CI run of G5.41-1 (scripts/check/fixtures/client-db-check-lanes.txt,
// as it appears in the job log with the runner's STEP prefix removed). The failure and error lines with lane prefixes, in the order they appeared, become the first failure line
// and PASS and STEP lines are not included.
caseTest('the first failure lines of a target are its failure and error lines', COMPUTE, async () => {
  const { failures } = await import('./report.mts');
  const found = failures();
  for (const line of readFileSync(resolve(repo, 'scripts/check/fixtures/client-db-check-lanes.txt'), 'utf8').split('\n').filter(Boolean)) found.line(line);
  found.exit('make --no-print-directory -k client-db-check exited with 2');
  assert.deepEqual(found.lines(), [
    "[rust] thread 'main' (33354) panicked at tests/src/integration.rs:110:80:",
    '[rust] sqlite: schema().install: DRIVER: disk I/O error',
    '[rust] FAIL columns_and_subqueries/sqlite elapsed=5ms: sqlite: schema().install: DRIVER: disk I/O error',
    '[rust] client-db-test: the rust lane failed:',
    '[rust]   /home/runner/work/orm/orm/.runtime/run/client-db-rust-20422/debug/integration /home/runner/work/orm/orm/contracts/fixtures/bench/bench.dbs (exit 101)',
    'node scripts/client-db-test.mts: 107: echo: echo: I/O error',
    'client-db-test: failed lanes: rust',
    'make: *** [Makefile:549: client-db-check] Error 1',
    'make --no-print-directory -k client-db-check exited with 2',
  ]);
});

// The reported-error case (G5.57) is the feature-check line from the CI run of G5.53. The Go testcase records a failure as `stress_test.go:80: ...`
// and then writes only `FAIL <case> ...: the errors reported above`. The report line before it becomes the first failure line before the FAIL line, so even if the log
// shrinks its middle, the reason remains. Lines of cases that passed earlier are not included.
caseTest('a FAIL that points at the errors reported above keeps those errors as first failure lines', COMPUTE, async () => {
  const { failures } = await import('./report.mts');
  const found = failures();
  const step = 'STEP features/performance_gate/preempted-timing elapsed=1m15.37s: ';
  for (const line of [
    `${step}=== RUN   TestOther`,
    `${step}    other_test.go:12: a log line of a case that passed`,
    `${step}--- PASS: TestOther (0.01s)`,
    `${step}=== RUN   TestStressDocument`,
    `${step}RUN TestStressDocument deadline=5m0s`,
    `${step}    stress_test.go:80: stress median parse used 131ms of CPU, over the 100ms budget (docs/spec/dbspec.md, Verification)`,
    `${step}FAIL TestStressDocument elapsed=10.25s: the errors reported above`,
    `${step}--- FAIL: TestStressDocument (10.25s)`,
  ]) found.line(line);
  assert.deepEqual(found.lines().slice(0, 2), [
    `${step}    stress_test.go:80: stress median parse used 131ms of CPU, over the 100ms budget (docs/spec/dbspec.md, Verification)`,
    `${step}FAIL TestStressDocument elapsed=10.25s: the errors reported above`,
  ]);
});

// The passed-case case (G5.71) is the feature-unit-check line from a CI run. A coverage test's case shows the sample output
// that deliberately fails (`FAIL sample/...`) and ends with PASS. That line is not a target failure, so it is left out of the first failure line,
// and the real failure after it becomes the first failure line.
caseTest('the failure lines of a case that passed are not the first failure lines of the target', COMPUTE, async () => {
  const { failures } = await import('./report.mts');
  const found = failures();
  const sample = Array.from({ length: 25 }, (_, i) => `FAIL sample/owner/typescript/none run ${i} elapsed=31ms: unexpected test output: {"success":true}`);
  for (const line of [
    'RUN a sample of every client runs through its owning file deadline=5m0s',
    ...sample,
    'PASS a sample of every client runs through its owning file elapsed=2.1s',
    'RUN every tracked file selects a behaviour test or declares its scope deadline=1m0s',
    "FAIL every tracked file selects a behaviour test or declares its scope elapsed=75ms: packages/rust/build/tests/unit/row_insert_lock.rs selects no behaviour test",
  ]) found.line(line);
  assert.deepEqual(found.lines(), [
    "FAIL every tracked file selects a behaviour test or declares its scope elapsed=75ms: packages/rust/build/tests/unit/row_insert_lock.rs selects no behaviour test",
  ]);
});

// The warning case (G5.73) checks that `WARNING` lines, where a performance measurement exceeded the reference value, are collected as warnings rather than failures, and that the summary
// records them separately.
caseTest('a WARNING line is kept as a warning, not a failure, and the summary lists it', COMPUTE, async () => {
  const { failureLine, failures, summary } = await import('./report.mts');
  const found = failures();
  const warned = 'dbspec_stress median parse CPU of 401.000 ms is 11.50 times the reference CPU of 34.870 ms, above the reference ratio 11.0 (docs/spec/dbspec.md, Verification); machine Linux aarch64, PHP 8.5.4';
  for (const line of ['RUN dbspec_stress deadline=10m0s', `STEP features/helpers/dbspec-stress elapsed=2s: WARNING ${warned}`, 'PASS dbspec_stress elapsed=2.5s']) found.line(line);
  assert.equal(failureLine(`STEP features/helpers/dbspec-stress elapsed=2s: WARNING ${warned}`), false, 'a warning is no failure line');
  assert.deepEqual(found.warnings(), [warned]);
  const text = summary({ commit: 'c', tree: 't', started: 's', ended: 'e', result: 'passed', setup: [], targets: [{ name: 'feature-check', status: 'passed', warnings: [warned] }] });
  assert.match(text, /\| feature-check \| passed \|/);
  assert.ok(text.includes(`## warnings\n\nA warning is no failure: a measurement exceeded its documented reference value (AGENTS.md).\n\n- feature-check: ${warned}`), text);
});

// The space case (G5.43-4) is a run in which target b fails because /tmp exceeds its quota (EDQUOT). The report records space at the start and at each step
// and b's first failure line states that it failed for lack of space, along with the free space of `/` and `/tmp` at that moment.
caseTest('a target that runs out of space says so with the free space of / and /tmp', PROCESS, () => {
  const c = checkout(scope);
  try {
    assert.equal(c.run('', { STUB_SUITE: 'space', ORM_CHECK_RUN_ID: '11-1' }).status, 1);
    const record = c.record();
    const b = named(record, 'b');
    assert.match(b.failures?.[0] ?? '', /^out of space: the target failed with ENOSPC or EDQUOT; \/ \d+\.\d\d GiB free, \/tmp \d+\.\d\d GiB free.*; the largest under \/tmp: /);
    assert.match(b.failures?.[1] ?? '', /disk quota exceeded$/);
    assert.ok((record.disk?.['/'] ?? 0) > 0 && (b.disk?.['/tmp'] ?? 0) > 0, JSON.stringify([record.disk, b.disk]));
    const disk = join(c.root, '.runtime/check/ci_11_1/report/disk');
    assert.deepEqual(readdirSync(disk), ['00-start.txt', '01-downloads.txt', '02-servers.txt', '03-databases-create.txt', '04-a.txt', '05-b.txt', '06-c.txt', '07-databases-drop.txt']);
    assert.match(readFileSync(join(disk, '05-b.txt'), 'utf8'), /^## df -k \/ \/tmp[^\n]*\n[^]*## the largest entries of \/tmp \(KiB\)\n[^]*## files under \/tmp that were removed but are still open \(lsof \+L1\)/);
  } finally {
    cleanup();
  }
});

// The case-name case (G5.44-2) is the client-db-check output from the CI run of G5.43-4. The case name in the TypeScript lane
// `driver-error/...` contains an error word, but that step line only created and removed a database, so it is not the first failure line; the first failure
// line is the Rust lane's failure.
caseTest('a case name that holds an error word does not make its step lines failures', COMPUTE, async () => {
  const { failures } = await import('./report.mts');
  const found = failures();
  for (const line of [
    '[typescript] RUN driver-error/trigger_refused/sqlite deadline=30s',
    '[typescript] STEP driver-error/trigger_refused/sqlite elapsed=5ms: database file /tmp/orm-case-27838-1.sqlite created',
    '[typescript] STEP driver-error/trigger_refused/sqlite elapsed=42ms: database file /tmp/orm-case-27838-1.sqlite removed',
    '[typescript] PASS driver-error/trigger_refused/sqlite elapsed=43ms',
    '[typescript] RUN driver-error/check_refused/mysql deadline=30s',
    '[typescript] STEP driver-error/check_refused/mysql elapsed=14ms: database orm_case_27838_5 created',
    '[typescript] STEP driver-error/check_refused/mysql elapsed=106ms: database orm_case_27838_5 dropped',
    '[typescript] PASS driver-error/check_refused/mysql elapsed=107ms',
    '[rust] STEP invalid/every-error-in-order elapsed=77µs: cpu=79.824µs wall=80.636µs',
    '[rust] FAIL audit_record_transaction elapsed=29ms: install: DRIVER: disk I/O error',
    "[rust] thread 'audit_record_transaction' (29159) panicked at orm/tests/common/audit_rows.rs:87:67:",
    '[rust] STEP plan elapsed=3ms: write /tmp/go-build1/b001/_testmain.go: disk quota exceeded',
    'error: could not compile `polyspec-orm-build` (test "row_mutation")',
  ]) found.line(line);
  assert.deepEqual(found.lines(), [
    '[rust] FAIL audit_record_transaction elapsed=29ms: install: DRIVER: disk I/O error',
    "[rust] thread 'audit_record_transaction' (29159) panicked at orm/tests/common/audit_rows.rs:87:67:",
    '[rust] STEP plan elapsed=3ms: write /tmp/go-build1/b001/_testmain.go: disk quota exceeded',
    'error: could not compile `polyspec-orm-build` (test "row_mutation")',
  ]);
});

// The disk I/O error case (G5.44-2) is target b, which fails with a SQLite disk I/O error. If /tmp has 0 bytes free at that moment, the first failure line
// records the lack of space and the largest deleted-but-open file; if space remains, the error alone is not recorded as lack of space.
caseTest('a disk I/O error is out of space only while a file system has no free space', PROCESS, () => {
  const c = checkout(scope);
  try {
    assert.equal(c.run('', { STUB_SUITE: 'diskio-full', ORM_CHECK_RUN_ID: '12-1' }).status, 1);
    const full = named(c.record(), 'b');
    assert.equal(full.failures?.[0] ?? '', 'out of space: the target failed with a disk I/O error while /tmp had no free space; / 0.00 GiB free, /tmp 0.00 GiB free; the largest under /tmp: none listed; the largest removed but open file: 6192.9 MiB by lsof SIZE/OFF, /tmp/orm-binlog-AHN00Q/mysqld.log (mysqld 10079)');
    assert.match(full.failures?.[1] ?? '', /disk I\/O error$/);
    const d = checkout(scope);
    assert.equal(d.run('', { STUB_SUITE: 'diskio-free', ORM_CHECK_RUN_ID: '12-2' }).status, 1);
    const free = named(d.record(), 'b');
    assert.equal(free.failures?.[0] ?? '', '[rust] FAIL audit_record_transaction elapsed=29ms: install: DRIVER: disk I/O error');
  } finally {
    cleanup();
  }
});

// The npm case (G5.44-3) is target b, which fails and points only to a debug log outside the report, as npm does. The report moves that log into targets/b/,
// and its first failure line is the error line of that log.
caseTest('a failed npm command keeps its debug log and its error lines in the report', PROCESS, () => {
  const c = checkout(scope);
  try {
    const debug = join(c.root, '..', '2026-10-05T11_42_43_213Z-debug-0.log');
    assert.equal(c.run('', { STUB_SUITE: 'npm', STUB_NPM_LOG: debug, ORM_CHECK_RUN_ID: '13-1' }).status, 1);
    const b = named(c.record(), 'b');
    assert.deepEqual(b.failures?.slice(0, 2), [
      'npm debug log .runtime/check/ci_13_1/report/targets/b/2026-10-05T11_42_43_213Z-debug-0.log: code E404',
      'npm debug log .runtime/check/ci_13_1/report/targets/b/2026-10-05T11_42_43_213Z-debug-0.log: 404 Not Found - GET https://registry.npmjs.org/x - Not found',
    ]);
    assert.equal(readFileSync(join(c.root, '.runtime/check/ci_13_1/report/targets/b/2026-10-05T11_42_43_213Z-debug-0.log'), 'utf8'), readFileSync(debug, 'utf8'));
  } finally {
    cleanup();
  }
});

// The CI-setup case (G5.52) is a run in which the CI setup step rust fails. The runner records setup phase ci/rust as failed, and records a
// target that needs rust, a, along with that step, as not-run; b and c run. Even if it fails, a step the targets do not need (rust-cache)
// is not recorded.
caseTest('a failed CI setup step marks the targets that need it not-run and runs every other target', PROCESS, () => {
  const c = checkout(scope);
  try {
    assert.equal(c.run('', { STUB_SUITE: 'cisetup', ORM_CHECK_RUN_ID: '14-1' }).status, 1);
    const record = c.record();
    assert.deepEqual(record.setup.map(({ name, status }) => [name, status]).filter(([name = '']) => name.startsWith('ci/')), [['ci/rust', 'failed']]);
    const a = named(record, 'a');
    assert.equal(a.status, 'not-run');
    assert.match(a.reason ?? '', /^the CI setup step rust failed; its output is in the job log of that step/);
    assert.deepEqual(record.targets.filter(target => target.name !== 'a').map(({ name, status }) => [name, status]), [['b', 'passed'], ['c', 'passed']]);
    const ran = c.ran();
    assert.ok(ran.includes('b') && ran.includes('c') && !ran.includes('a'), ran.join(' '));
  } finally {
    cleanup();
  }
});


// The databases setup-need case (G5.127) is a run in which the setup step that databases/create requires (server-programs) is not prepared. The runner
// neither reads the server nor creates a database; it records targets declaring databases as not-run with that step, and runs the other targets.
caseTest('a run without the setup step that databases/create needs records the database targets as not-run', PROCESS, () => {
  const c = checkout(scope);
  try {
    assert.equal(c.run('', { STUB_SUITE: 'server-programs', ORM_CHECK_RUN_ID: '17-1-stress' }).status, 1);
    const record = c.record();
    assert.deepEqual(record.setup.map(({ name, status }) => [name, status]).filter(([name = '']) => name.startsWith('ci/') || name.startsWith('databases') || name === 'servers'), [['ci/server-programs', 'failed']]);
    for (const name of ['a', 'c']) {
      const target = named(record, name);
      assert.equal(target.status, 'not-run', name);
      assert.match(target.reason ?? '', /^the setup steps servers and databases\/create need server-programs: the CI setup step server-programs was skipped, and a target of this run needs server-programs/);
    }
    assert.equal(named(record, 'b').status, 'passed');
    assert.deepEqual(c.ran(), ['b']);
  } finally {
    cleanup();
  }
});

// The CI group case (G5.111) is a run of a job in which group-needs skipped a setup step. If no target in this run declares the need of the skipped step,
// that step is not recorded as a setup phase, and since no target needs a database, the servers and databases phases are also
// absent, and all targets run and pass. A target that needs the skipped rust is not-run, with that step and its reason.
caseTest('a CI group job ignores the setup steps it skipped for needs of no target and starts no databases without a database target', PROCESS, () => {
  const c = checkout(scope);
  try {
    const result = c.run('', { STUB_SUITE: 'group', ORM_CHECK_RUN_ID: '15-1-static' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const record = c.record();
    assert.deepEqual(record.setup.map(({ name, status }) => [name, status]), [['downloads', 'passed']]);
    assert.deepEqual(record.targets.map(({ name, status }) => [name, status]), [['a', 'passed'], ['b', 'passed'], ['c', 'passed']]);
    assert.deepEqual(c.ran(), ['a', 'b', 'c']);
    assert.match(result.stdout, /check: the CI setup step rust was skipped; no target of this run needs rust/);
    assert.match(result.stdout, /check: no target of this run needs databases; the run reads no servers and creates no databases/);
  } finally {
    cleanup();
  }
});

caseTest('a CI group job records a target not-run when it needs a setup step that the job skipped', PROCESS, () => {
  const c = checkout(scope);
  try {
    assert.equal(c.run('', { STUB_SUITE: 'group-rust', ORM_CHECK_RUN_ID: '16-1-static' }).status, 1);
    const record = c.record();
    assert.deepEqual(record.setup.map(({ name, status }) => [name, status]).filter(([name = '']) => name.startsWith('ci/')), [['ci/rust', 'failed']]);
    const a = named(record, 'a');
    assert.equal(a.status, 'not-run');
    assert.match(a.reason ?? '', /^the CI setup step rust was skipped, and a target of this run needs rust; make ci-group-needs runs the setup steps/);
    assert.deepEqual(record.targets.filter(target => target.name !== 'a').map(({ name, status }) => [name, status]), [['b', 'passed'], ['c', 'passed']]);
  } finally {
    cleanup();
  }
});

// The no-server run case (G5.67) runs the runner without servers, as make docs-ci does in the docs workflow. Server and database
// steps are absent, targets that need a database are not-run, the other targets run, and the summary and target logs remain in that run's
// report.
caseTest('a run without servers runs the targets that need no database and reports them', PROCESS, async () => {
  const { runChecks } = await import('./run.mts');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-')));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
    const ran: string[] = [];
    const run = async (program: string, args: string[], step: (line: string) => void) => { ran.push(args.at(-1) ?? ''); step(`ran ${args.at(-1) ?? ''}`); };
    const code = await runChecks({ root, servers: null, targets: ['docs-a', 'db-b'], run, needs: { 'docs-a': [], 'db-b': ['databases'] },
      id: '77-1-docs', snapshot: () => ({ text: 'stub\n', places: { '/': 1 } }), ciSetup: '',
      // A missing crate is not needed by this run's targets, so it does not fail the downloads step.
      downloads: () => [{ need: 'rust', message: 'the crates of packages/rust/Cargo.lock are not downloaded; run make install, which downloads it' }] });
    assert.equal(code, 1);
    assert.deepEqual(ran, ['docs-a']);
    const report = join(root, '.runtime/check/ci_77_1_docs/report');
    const text = readFileSync(join(report, 'summary.md'), 'utf8');
    assert.match(text, /\| downloads \| passed \|/);
    assert.match(text, /\| docs-a \| passed \|/);
    assert.match(text, /\| db-b \| not-run \| {2}\| this run has no database servers \|/);
    assert.doesNotMatch(text, /\| servers \||databases\/create/);
    assert.match(readFileSync(join(report, 'targets/docs-a.log'), 'utf8'), /ran docs-a/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
