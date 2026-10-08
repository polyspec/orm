// Tests of scripts/kit/run-tests.mjs and its progress reporters: the progress lines, the per-test timeout, the failing run
// without a test, the file that registers no test or registers it late, and the parsers of the output of go, cargo and
// PHPUnit. The runs use fixture test files in a temporary checkout and stubs of the tools on PATH; nothing needs a network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cargoEvents, goEvents, parseArguments, phpunitEvents, run, toolCommand } from '../../scripts/kit/run-tests.mjs';
import { createProgress } from '../../scripts/kit/test-progress.mjs';
import { tree } from './tree.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/kit');
const SPEC = "import test from 'node:test';\n";

function checkout(t, files) {
  const root = tree(t, files);
  cpSync(KIT, path.join(root, 'scripts/kit'), { recursive: true });
  return root;
}
const runner = (root, args, env = {}) => spawnSync(process.execPath, ['scripts/kit/run-tests.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
const output = result => result.stdout + result.stderr;

test('a passing file prints the start and the result of each test and a summary, and exits 0', (t) => {
  const root = checkout(t, { 'tests/a.test.mjs': `${SPEC}test('adds', () => {});\ntest('group', async (t) => { await t.test('inner', () => {}); });\n` });
  const result = runner(root, ['node', '--', 'tests/a.test.mjs']);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /▶ node \. tests\/a\.test\.mjs \(each test 30s\)/);
  assert.match(result.stdout, /▶ tests\/a\.test\.mjs › adds/);
  assert.match(result.stdout, /✔ tests\/a\.test\.mjs › adds \(\d+\.\ds\)/);
  assert.match(result.stdout, /✔ tests\/a\.test\.mjs › group › inner/);
  assert.match(result.stdout, /✔ node --test: 3 passed, 0 failed, 0 timed out, 0 skipped/);
});

test('a directory runs the test files below it', (t) => {
  const root = checkout(t, { 'tests/one/a.test.mjs': `${SPEC}test('a', () => {});\n`, 'tests/one/b.test.mjs': `${SPEC}test('b', () => {});\n` });
  const result = runner(root, ['node', 'tests/one']);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /2 passed/);
});

test('a failing test prints its failure and exits 1', (t) => {
  const root = checkout(t, { 'tests/a.test.mjs': `${SPEC}test('breaks', () => { throw new Error('expected 1, actual 2'); });\ntest('fine', () => {});\n` });
  const result = runner(root, ['node', '--', 'tests/a.test.mjs']);
  assert.equal(result.status, 1, output(result));
  assert.match(result.stdout, /✖ tests\/a\.test\.mjs › breaks/);
  assert.match(result.stdout, /expected 1, actual 2/);
  assert.match(result.stdout, /✔ tests\/a\.test\.mjs › fine/);
});

test('a test that outlives --timeout fails, and the run has no other limit', (t) => {
  const root = checkout(t, { 'tests/a.test.mjs': `${SPEC}test('slow', async () => { await new Promise(resolve => setTimeout(resolve, 8000)); });\n` });
  const started = Date.now();
  const result = runner(root, ['node', '--timeout', '1', '--', 'tests/a.test.mjs']);
  assert.equal(result.status, 1, output(result));
  assert.match(result.stdout, /\(each test 1s\)/);
  assert.match(result.stdout, /✖ tests\/a\.test\.mjs › slow/);
  assert.match(result.stdout, /timed out after 1000ms/);
  assert.ok(Date.now() - started < 7000, 'the timeout stopped the test');
});

test('a run in which no test ran fails: a file without a test case, only skipped tests, no matching file', (t) => {
  const root = checkout(t, {
    'tests/none.test.mjs': SPEC,
    'tests/skip.test.mjs': `${SPEC}test('later', { skip: true }, () => {});\n`,
    'tests/ok.test.mjs': `${SPEC}test('ok', () => {});\n`,
  });
  const none = runner(root, ['node', '--', 'tests/none.test.mjs']);
  assert.equal(none.status, 1, output(none));
  assert.match(none.stdout, /the file ran no test case/);
  assert.match(none.stdout, /no test ran: expected at least 1 test that passes, fails or runs out of time, actual 0/);
  const skipped = runner(root, ['node', '--', 'tests/skip.test.mjs']);
  assert.equal(skipped.status, 1, output(skipped));
  assert.match(skipped.stdout, /no test ran: expected at least 1 test that passes, fails or runs out of time, actual 0 \(1 skipped\)/);
  const absent = runner(root, ['node', '--', 'tests/absent.test.mjs']);
  assert.equal(absent.status, 1, output(absent));
  assert.equal(runner(root, ['node', '--', 'tests/ok.test.mjs']).status, 0);
});

test('a file whose process ends before its module registered every test fails', (t) => {
  const root = checkout(t, { 'tests/late.test.mjs': `${SPEC}test('early', () => {});\nawait new Promise(resolve => setTimeout(resolve, 300));\ntest('late', () => {});\n` });
  const result = runner(root, ['node', '--', 'tests/late.test.mjs']);
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /the process ended before the module finished loading; tests registered later did not run/);
});

test('the arguments of the runner are read before the arguments of the tool', () => {
  const options = parseArguments(['node', '--timeout', '5', '--cwd', 'sub', '--', 'a.test.mjs', '--x'], '/repo');
  assert.deepEqual([options.tool, options.timeoutSeconds, options.cwd, options.args], ['node', 5, '/repo/sub', ['a.test.mjs', '--x']]);
  assert.equal(parseArguments(['phpunit', '--php-extension', 'ext.so'], '/repo').phpExtension, '/repo/ext.so');
  assert.equal(parseArguments(['go', './...'], '/repo').args[0], './...');
  for (const bad of [[], ['python'], ['node', '--timeout', '0'], ['node', '--timeout', 'x'], ['node', '--php-extension', 'x'], ['node', '--cwd']]) {
    assert.throws(() => parseArguments(bad, '/repo'), /Usage: node scripts\/kit\/run-tests\.mjs <node\|vitest\|go\|cargo\|phpunit>/, JSON.stringify(bad));
  }
});

test('each tool starts with its progress and timeout arguments and no limit on a whole run', () => {
  const node = toolCommand({ tool: 'node', timeoutSeconds: 7, cwd: '/r', args: ['a'] }, '/r');
  assert.ok(node.args.includes('--test-timeout=7000') && node.args.includes('--test-force-exit') && node.args.at(-1) === 'a');
  assert.ok(node.args.some(arg => arg.startsWith('--test-reporter=') && arg.endsWith('scripts/kit/node-reporter.mjs')));
  assert.ok(node.args.some(arg => arg.startsWith('--import=file://') && arg.endsWith('scripts/kit/test-load-check.mjs')));
  const vitest = toolCommand({ tool: 'vitest', timeoutSeconds: 7, cwd: '/r', args: [] }, '/r');
  assert.deepEqual(vitest.args.slice(0, 4), ['/r/node_modules/vitest/vitest.mjs', 'run', '--testTimeout=7000', '--hookTimeout=7000']);
  assert.deepEqual(toolCommand({ tool: 'go', timeoutSeconds: 7, cwd: '/r', args: ['./...'] }, '/r'), { command: 'go', args: ['test', '-json', '-count=1', '-timeout=0', './...'] });
  assert.deepEqual(toolCommand({ tool: 'cargo', timeoutSeconds: 7, cwd: '/r', args: ['-p', 'x', '--', '--nocapture'] }, '/r').args, ['test', '-p', 'x', '--', '--test-threads=1', '--nocapture']);
  assert.deepEqual(toolCommand({ tool: 'phpunit', timeoutSeconds: 7, cwd: '/r/p', args: ['t'] }, '/r'), { command: '/r/p/vendor/bin/phpunit', args: ['--teamcity', 't'] });
  assert.deepEqual(toolCommand({ tool: 'phpunit', timeoutSeconds: 7, cwd: '/r/p', args: [], phpExtension: '/r/e.so' }, '/r').args.slice(0, 3), ['-d', 'extension=/r/e.so', '/r/p/vendor/bin/phpunit']);
  process.env.COMPOSER_VENDOR_DIR = '/elsewhere';
  try {
    assert.equal(toolCommand({ tool: 'phpunit', timeoutSeconds: 7, cwd: '/r/p', args: [] }, '/r').command, '/elsewhere/bin/phpunit');
  } finally {
    delete process.env.COMPOSER_VENDOR_DIR;
  }
});

function recorder() {
  const lines = [];
  const counts = (resultFile) => createProgress({ write: text => lines.push(text), heartbeatMs: 10_000, resultFile });
  return { lines, counts };
}

test('the progress closes a run as failed when a test failed, a group failed, the tool failed, or nothing ran', (t) => {
  const { lines, counts } = recorder();
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'kit-progress-')), 'result.json');
  t.after(() => rmSync(path.dirname(file), { recursive: true, force: true }));
  const progress = counts(file);
  progress.start('a'); progress.pass('a', 10);
  progress.start('b'); progress.skip('b');
  assert.deepEqual(progress.close('suite'), { passed: 1, failed: 0, skipped: 1, timedOut: 0, ran: 1, ok: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { passed: 1, failed: 0, skipped: 1, timedOut: 0, ran: 1, ok: true });
  assert.match(lines.at(-1), /✔ suite: 1 passed, 0 failed, 0 timed out, 1 skipped/);

  const failing = counts();
  failing.start('x'); failing.fail('x', 5, 'boom\nmore');
  assert.equal(failing.close('suite').ok, false);
  assert.ok(lines.some(line => line.includes('           boom')));

  const group = counts();
  group.start('file', { group: true }); group.start('t'); group.pass('t', 1); group.fail('file', 1, 'hook failed');
  assert.equal(group.close('suite').ok, false);
  assert.match(lines.at(-1), /1 group failed/);

  const exiting = counts();
  exiting.start('t'); exiting.pass('t', 1);
  assert.equal(exiting.close('suite', { exitCode: 2, errors: ['error: link failed'] }).ok, false);
  assert.match(lines.at(-1), /the tool exited with 2: error: link failed/);

  const empty = counts();
  empty.start('t'); empty.skip('t');
  assert.deepEqual([empty.close('suite').ok, lines.at(-1).includes('no test ran')], [false, true]);

  const unfinished = counts();
  unfinished.start('hang');
  assert.equal(unfinished.close('suite').ok, false);
  assert.ok(lines.some(line => line.includes('the test did not finish')));
});

test('the progress reports a test that outlives its timeout', async () => {
  const lines = [];
  const stopped = [];
  const progress = createProgress({ write: text => lines.push(text), heartbeatMs: 20, timeoutMs: 50, onTimeout: id => stopped.push(id), command: 'tool run' });
  progress.start('slow');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(stopped, ['slow']);
  assert.ok(lines.some(line => /⏱ slow ran \d\.\ds and exceeded its 0\.1s timeout; stopping `tool run`/.test(line)), lines.join(''));
  assert.ok(lines.some(line => line.includes('… slow still running')));
  assert.equal(progress.close('suite').timedOut, 1);
});

test('the go events print tests, show the output of a failing test, name build errors and skip a package without a test', () => {
  const lines = [];
  const progress = createProgress({ write: text => lines.push(text), heartbeatMs: 10_000, resultFile: '' });
  const build = [];
  const feed = goEvents(progress, build);
  for (const event of [
    { Action: 'start', Package: 'p' }, { Action: 'run', Package: 'p', Test: 'TestA' }, { Action: 'pass', Package: 'p', Test: 'TestA', Elapsed: 0.5 },
    { Action: 'run', Package: 'p', Test: 'TestB' }, { Action: 'output', Package: 'p', Test: 'TestB', Output: '    b_test.go:9: want 1 got 2\n' }, { Action: 'output', Package: 'p', Test: 'TestB', Output: '--- FAIL: TestB (0.00s)\n' }, { Action: 'fail', Package: 'p', Test: 'TestB', Elapsed: 0.1 },
    { Action: 'pass', Package: 'p', Elapsed: 0.6 },
    { Action: 'start', Package: 'empty' }, { Action: 'pass', Package: 'empty', Elapsed: 0 },
    { Action: 'build-output', ImportPath: 'bad', Output: '# bad\nbad.go:3:1: syntax error\n' }, { Action: 'build-fail', ImportPath: 'bad' },
  ]) feed(JSON.stringify(event));
  feed('not json');
  const text = lines.join('');
  assert.match(text, /✔ p › TestA \(0\.5s\)/);
  assert.match(text, /✖ p › TestB/);
  assert.match(text, /b_test\.go:9: want 1 got 2/);
  assert.doesNotMatch(text, /--- FAIL/);
  assert.match(text, /○ empty skipped/);
  assert.match(text, /○ empty: ran no test case/);
  assert.match(text, /✖ build of bad failed/);
  assert.deepEqual(build, ['bad.go:3:1: syntax error']);
  assert.match(text, /not json/);
});

test('the cargo events pair each test with its result and name the binary', () => {
  const lines = [];
  const progress = createProgress({ write: text => lines.push(text), heartbeatMs: 10_000, resultFile: '' });
  const events = cargoEvents(progress);
  events.stderr('     Running unittests src/lib.rs (target/debug/deps/lib-1)');
  events.stdout('running 3 tests\ntest a ... ok\ntest b ... FAILED\ntest c ... ');
  events.stdout('ignored\n');
  const text = lines.join('');
  assert.match(text, /✔ src\/lib\.rs › a/);
  assert.match(text, /✖ src\/lib\.rs › b/);
  assert.match(text, /○ src\/lib\.rs › c skipped/);
  assert.equal(progress.close('cargo').ok, false);
});

test('the phpunit events pair tests, join the failure messages and print other lines', () => {
  const lines = [];
  const progress = createProgress({ write: text => lines.push(text), heartbeatMs: 10_000, resultFile: '' });
  const feed = phpunitEvents(progress);
  const message = (name, attributes) => `##teamcity[${name} ${Object.entries(attributes).map(([key, value]) => `${key}='${value}'`).join(' ')}]`;
  feed(message('testSuiteStarted', { name: 'all' }));
  feed(message('testStarted', { name: 'testOk', locationHint: 'php_qn://x/FooTest.php::\\Pkg\\FooTest::testOk' }));
  feed(message('testFinished', { name: 'testOk', duration: '12' }));
  feed(message('testStarted', { name: 'testBad', locationHint: 'php_qn://x/FooTest.php::\\Pkg\\FooTest::testBad' }));
  feed(message('testFailed', { name: 'testBad', message: 'Failed asserting|n1 is 2', details: 'at FooTest.php:9' }));
  feed(message('testFinished', { name: 'testBad', duration: '3' }));
  feed(message('testSuiteFinished', { name: 'all' }));
  feed('Tests: 2, Warnings: 1.');
  const text = lines.join('');
  assert.match(text, /✔ FooTest::testOk/);
  assert.match(text, /✖ FooTest::testBad/);
  assert.match(text, /Failed asserting\n\s+1 is 2/);
  assert.match(text, /Tests: 2, Warnings: 1\./);
  assert.equal(progress.close('phpunit').ok, false);
});

function stubTool(t, name, script) {
  const bin = mkdtempSync(path.join(tmpdir(), 'kit-stub-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const file = path.join(bin, name);
  writeFileSync(file, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(file, 0o755);
  return bin;
}

async function inProcess(t, args, { path: extraPath, root = tree(t) } = {}) {
  const lines = [];
  const previous = process.env.PATH;
  if (extraPath !== undefined) process.env.PATH = extraPath;
  try {
    return { status: await run(args, { root, write: text => lines.push(text) }), text: lines.join('') };
  } finally {
    process.env.PATH = previous;
  }
}

test('go tests run through a tool on PATH and pass', async (t) => {
  const events = [{ Action: 'start', Package: 'p' }, { Action: 'run', Package: 'p', Test: 'TestA' }, { Action: 'pass', Package: 'p', Test: 'TestA', Elapsed: 0 }, { Action: 'pass', Package: 'p', Elapsed: 0 }];
  const bin = stubTool(t, 'go', `for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));`);
  const result = await inProcess(t, ['go', './...'], { path: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(result.status, 0, result.text);
  assert.match(result.text, /✔ go \. \.\/\.\.\.: 1 passed/);
});

test('a go tool that reports no test fails the run', async (t) => {
  const bin = stubTool(t, 'go', `console.log(JSON.stringify({ Action: 'start', Package: 'p' })); console.log(JSON.stringify({ Action: 'pass', Package: 'p', Elapsed: 0 }));`);
  const result = await inProcess(t, ['go', './...'], { path: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(result.status, 1, result.text);
  assert.match(result.text, /no test ran/);
});

test('a go test that outlives the timeout stops the tool and fails the run', async (t) => {
  const bin = stubTool(t, 'go', `console.log(JSON.stringify({ Action: 'start', Package: 'p' })); console.log(JSON.stringify({ Action: 'run', Package: 'p', Test: 'TestHang' })); setInterval(() => {}, 1000);`);
  const result = await inProcess(t, ['go', '--timeout', '1', './...'], { path: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(result.status, 1, result.text);
  assert.match(result.text, /⏱ p › TestHang ran \d\.\ds and exceeded its 1\.0s timeout; stopping `go test -json`/);
});

test('a tool that cannot start fails with its command and the fix', async (t) => {
  const missing = path.join(tmpdir(), 'kit-no-such-directory');
  const result = await inProcess(t, ['go', './...'], { path: missing });
  assert.equal(result.status, 1);
  assert.match(result.text, /✖ go \. \.\/\.\.\.: cannot start go: .*; run make install-tools, which installs Go into var\/tools/);
  const phpunit = await inProcess(t, ['phpunit'], { path: missing });
  assert.match(phpunit.text, /cannot start .*vendor\/bin\/phpunit: .*; run composer install in \./);
});

test('a PHP extension that is not built fails before the tool starts', async (t) => {
  const result = await inProcess(t, ['phpunit', '--php-extension', 'build/ext.so']);
  assert.equal(result.status, 1);
  assert.match(result.text, /the PHP extension build\/ext\.so is not built; build it before the run/);
});
