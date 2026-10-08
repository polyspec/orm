// Tests of scripts/kit/ci-targets.mjs, target-report.mjs and ci-passed.mjs: the run of make targets past failures, the
// report with its logs, record and summary, the first failure lines, and the judgment of the results of the needed jobs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ciSummary, ciTargets } from '../../scripts/kit/ci-targets.mjs';
import { acquireHolderLock, HolderLockRefused, removeDeadLock } from '../../scripts/kit/holder-lock.mjs';
import { passed } from '../../scripts/kit/ci-passed.mjs';
import { capLog, failureLines, reportWriter, warningLines } from '../../scripts/kit/target-report.mjs';
import { put, tree } from './tree.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/kit');
const MAKEFILE = `good:
\t@echo ran-good
bad:
\t@echo "src/a.js:3:1: rule: expected 1, actual 2"; echo fine-line; exit 2
warn:
\t@echo "WARNING bundle is 12 KiB, above its 10 KiB limit"; echo ok
mixed:
\t@printf 'partial'; echo ' out' >&2; echo ' more'
flags:
\t@echo flags-ran
`;

function setup(t, files = {}) {
  return tree(t, { Makefile: MAKEFILE, ...files });
}
async function run(root, targets, extra = {}) {
  const printed = [];
  const outputs = [];
  const status = await ciTargets({ root, directory: 'var/report/ci', targets, environment: { node: 'v-test' }, env: { PATH: process.env.PATH }, print: line => printed.push(line), output: (text, stream) => outputs.push([stream, text]), ...extra });
  const read = file => readFileSync(path.join(root, 'var/report/ci', file), 'utf8');
  return { status, printed, outputs, read, record: () => JSON.parse(read('record.json')) };
}

test('every target runs to its end and the report holds a log, a record and a summary', async (t) => {
  const root = setup(t);
  const result = await run(root, ['good', 'warn']);
  assert.equal(result.status, 0, result.printed.join('\n'));
  assert.match(result.read('targets/good.log'), /^make --no-print-directory -k good\nran-good\n\[report\] make good exited with status 0\n$/);
  const record = result.record();
  assert.equal(record.result, 'passed');
  assert.deepEqual(record.targets.map(target => [target.name, target.status, target.log]), [['good', 'passed', 'targets/good.log'], ['warn', 'passed', 'targets/warn.log']]);
  assert.deepEqual(record.environment, { node: 'v-test' });
  assert.deepEqual(record.reportErrors, []);
  assert.match(result.read('summary.md'), /^# make ci-targets good warn\n[\s\S]*2 of 2 targets passed, 0 failed, 0 not finished, 1 warning\.[\s\S]*\| good \| passed \| [\d.]+ s \|/);
  assert.match(result.read('summary.md'), /## warnings\n\n- warn: WARNING bundle is 12 KiB, above its 10 KiB limit/);
  assert.ok(result.printed.includes('[ci-targets] start good (1/2)'));
  assert.ok(result.printed.some(line => /^\[ci-targets\] good passed in [\d.]+ s$/.test(line)));
  assert.ok(result.outputs.some(([stream, text]) => stream === 'stdout' && text === 'ran-good\n'));
});

test('a failed target does not stop the next one, and the report names its first failure lines and its log', async (t) => {
  const root = setup(t);
  const result = await run(root, ['bad', 'good']);
  assert.equal(result.status, 1);
  const record = result.record();
  assert.deepEqual(record.targets.map(target => target.status), ['failed', 'passed']);
  assert.equal(record.result, 'failed');
  assert.deepEqual(record.targets[0].failures, ['src/a.js:3:1: rule: expected 1, actual 2', 'make bad exited with status 2']);
  const summary = result.read('summary.md');
  assert.match(summary, /1 of 2 targets passed, 1 failed/);
  assert.match(summary, /## bad: failed\n\nLog: targets\/bad\.log\n\n```\nsrc\/a\.js:3:1: rule: expected 1, actual 2\nmake bad exited with status 2\n```/);
  assert.ok(result.printed.includes('[ci-targets] 1 of 2 targets passed; failed: bad'));
  assert.match(result.read('targets/good.log'), /ran-good/);
});

test('the output of standard output and of standard error never joins on one line', async (t) => {
  const root = setup(t);
  const result = await run(root, ['mixed']);
  assert.equal(result.status, 0);
  const lines = result.read('targets/mixed.log').split('\n');
  assert.ok(lines.includes('partial more'), lines.join('|'));
  assert.ok(lines.includes(' out'), lines.join('|'));
});

test('a target does not inherit the flags of a calling make', async (t) => {
  const root = setup(t);
  // With MAKEFLAGS=-n the recipe would be printed and not run.
  const result = await run(root, ['flags'], { env: { ...process.env, MAKEFLAGS: '-n', MAKELEVEL: '1' } });
  assert.equal(result.status, 0);
  assert.match(result.read('targets/flags.log'), /^flags-ran$/m);
  assert.doesNotMatch(result.read('targets/flags.log'), /echo flags-ran/);
});

test('a make that cannot start fails the target with the reason', async (t) => {
  const root = setup(t);
  const result = await run(root, ['good'], { make: path.join(root, 'no-such-make') });
  assert.equal(result.status, 1);
  assert.match(result.record().targets[0].failures.at(-1), /^make good could not start: /);
});

test('a failed write of the report is recorded, every target still runs and the run fails', async (t) => {
  const root = setup(t, { blocker: 'file' });
  const result = await run(root, ['good', 'flags'], { env: { ...process.env, GITHUB_STEP_SUMMARY: path.join(root, 'blocker/summary.md') } });
  assert.equal(result.status, 1);
  assert.deepEqual(result.record().targets.map(target => target.status), ['passed', 'passed']);
  assert.ok(result.record().reportErrors.some(error => error.startsWith('report write failed: ') && error.includes('blocker/summary.md')), JSON.stringify(result.record().reportErrors));
  assert.ok(result.printed.some(line => line.includes('report writes failed')));
});

test('the summary is appended to the job summary of GitHub Actions', async (t) => {
  const root = setup(t);
  const summary = path.join(root, 'job-summary.md');
  await run(root, ['good'], { env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.match(readFileSync(summary, 'utf8'), /^# make ci-targets good\n/);
});

test('the report of an earlier run is removed and a run holds the lock of its report', async (t) => {
  const root = setup(t);
  put(root, { 'var/report/ci/targets/old.log': 'old' });
  await run(root, ['good']);
  assert.throws(() => statSync(path.join(root, 'var/report/ci/targets/old.log')), /ENOENT/);
  const lock = path.join(root, 'var/report/ci.lock');
  assert.throws(() => statSync(lock), /ENOENT/, 'the lock is released');
  const held = acquireHolderLock(lock, { checkout: root, command: 'another run' });
  await assert.rejects(run(root, ['good']), /ci\.lock is held by process \d+ .*for "another run"; the holder releases it when its run ends/);
  held.release();
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  writeFileSync(lock, `${JSON.stringify({ checkout: root, pid: Number(dead), processStart: 'long ago', acquired: 'then', command: 'ended run', token: 'x' })}\n`);
  await assert.rejects(run(root, ['good']), /ci\.lock is held by process \d+ .*which has ended; remove the lock with `node .*holder-lock\.mjs clear /);
  removeDeadLock(lock);
  assert.equal((await run(root, ['good'])).status, 0, 'the lock of an ended holder is removed with clear and the next run holds it');
  const other = acquireHolderLock(path.join(root, 'other.lock'));
  assert.throws(() => acquireHolderLock(path.join(root, 'other.lock')), HolderLockRefused);
  other.release();
});

test('the failure lines prefer the marked failures, skip passing lines and end with how make ended', () => {
  const exit = 'make t exited with status 2';
  assert.deepEqual(failureLines(['✔ a (0.1s)', '✖ b (0.2s)', '   AssertionError: x', '   at f.js:1', 'error: noise', 'tail'], exit), ['✖ b (0.2s)', '   AssertionError: x', '   at f.js:1', exit]);
  assert.deepEqual(failureLines(['✔ suite: 3 passed, 0 failed', '▶ starts an error handler', 'ok (12 ms)', 'make[1]: *** [t] Error 2', 'src/a.rs:4:2: expected x', 'Traceback (most recent call last)'], exit), ['src/a.rs:4:2: expected x', 'Traceback (most recent call last)', exit]);
  assert.deepEqual(failureLines(['\u001b[31merror\u001b[0m: boom'], exit), ['error: boom', exit]);
  assert.deepEqual(failureLines(['one', '', 'two'], exit), ['one', 'two', exit], 'without a failure line the last lines are kept');
  const many = Array.from({ length: 40 }, (_, index) => `✖ failure ${index}`);
  assert.equal(failureLines(many, exit).length, 21);
});

test('warning lines are read from the output of a target', () => {
  assert.deepEqual(warningLines(['WARNING a', 'not WARNING b', '\u001b[33mWARNING c\u001b[0m']), ['WARNING a', 'WARNING c']);
});

test('a log above the limit keeps its head and its tail', (t) => {
  const root = tree(t, { 'big.log': `${'a'.repeat(100)}${'b'.repeat(100)}${'c'.repeat(100)}` });
  const file = path.join(root, 'big.log');
  assert.equal(capLog(file, 1000, 100), false);
  assert.equal(capLog(file, 200, 50), true);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^a{100}b{50}\n\[report\] 100 bytes of the output are left out here; the first 150 and the last 50 bytes are kept\nc{50}$/);
});

test('a report writer never throws and records a failed write', (t) => {
  const root = tree(t, { blocker: 'file' });
  const printed = [];
  const writer = reportWriter(line => printed.push(line));
  writer.write(path.join(root, 'blocker/x.json'), '{}');
  writer.append(path.join(root, 'blocker/y.md'), 'x');
  writer.write(path.join(root, 'ok/z.json'), '{}');
  assert.equal(writer.errors.length, 2);
  assert.match(writer.errors[0], /^report write failed: .*blocker\/x\.json: /);
  assert.equal(readFileSync(path.join(root, 'ok/z.json'), 'utf8'), '{}');
});

test('the summary of a report is written again from its record, also for a run that stopped', async (t) => {
  const root = setup(t);
  const printed = [];
  assert.equal(ciSummary({ root, directory: 'var/report/ci', print: line => printed.push(line) }), 0);
  assert.match(readFileSync(path.join(root, 'var/report/ci/summary.md'), 'utf8'), /\*\*make ci-targets recorded no run\*\*/);
  const record = { title: 'make ci-targets a b', tree: 't1', result: 'incomplete', started: 's', ended: null, environment: {}, targets: [{ name: 'a', status: 'passed', elapsedMs: 1000 }, { name: 'b', status: 'running' }] };
  put(root, { 'var/report/ci/record.json': JSON.stringify(record) });
  ciSummary({ root, directory: 'var/report/ci', env: { CI_STEPS: JSON.stringify({ install: { outcome: 'failure' }, lint: { outcome: 'success' }, cache: { outcome: 'skipped' } }) }, print: line => printed.push(line) });
  const text = readFileSync(path.join(root, 'var/report/ci/summary.md'), 'utf8');
  assert.match(text, /The runner ended without recording the end of its run; b was running\./);
  assert.match(text, /\| install \| failure \|/);
  assert.match(text, /- the setup step install did not succeed/);
  assert.doesNotMatch(text, /the setup step (lint|cache)/);
  put(root, { 'var/report/ci/record.json': '{broken' });
  ciSummary({ root, directory: 'var/report/ci', env: { CI_STEPS: 'nope' }, print: line => printed.push(line) });
  assert.ok(printed.some(line => line.startsWith('[ci-targets] CI_STEPS is not JSON: ')));
  assert.match(readFileSync(path.join(root, 'var/report/ci/summary.md'), 'utf8'), /recorded no run\*\* \(var\/report\/ci\/record\.json: /);
});

function command(root, args, env = {}) {
  return spawnSync(process.execPath, ['scripts/kit/ci-targets.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
}

test('the command runs the targets, exits with the result and refuses a bad usage', (t) => {
  const root = setup(t);
  cpSync(KIT, path.join(root, 'scripts/kit'), { recursive: true });
  const failed = command(root, ['var/report/ci', 'bad', 'good']);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /\[ci-targets\] 1 of 2 targets passed; failed: bad/);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'var/report/ci/record.json'), 'utf8')).result, 'failed');
  assert.equal(command(root, ['var/report/ci', 'good']).status, 0);
  const summary = command(root, ['--summary', 'var/report/ci']);
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /# make ci-targets good/);
  for (const [args, message] of [[[], /usage: node scripts\/kit\/ci-targets\.mjs/], [['var/report/ci'], /usage:/], [['var/report/ci', 'a/b'], /the target name "a\/b" is not a make target name/], [['var/report/ci', 'good', 'good'], /the target good is listed twice/]]) {
    const refused = command(root, args);
    assert.equal(refused.status, 2, `${args.join(' ')}: ${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, message);
  }
});

const ok = { result: 'success', outputs: {} };

test('ci-passed passes when every needed job succeeded', () => {
  const result = passed(JSON.stringify({ lint: ok, test: ok }));
  assert.equal(result.status, 0);
  assert.deepEqual(result.lines, ['[ci-passed] lint: success', '[ci-passed] test: success', '[ci-passed] every needed job passed: lint, test']);
});

test('ci-passed fails for a job that failed, was skipped or was cancelled, and names it', () => {
  const result = passed(JSON.stringify({ lint: ok, test: { result: 'failure' }, docs: { result: 'skipped' }, e2e: { result: 'cancelled' }, odd: {} }));
  assert.equal(result.status, 1);
  assert.deepEqual(result.errors, ['the job test ended with failure; expected success', 'the job docs ended with skipped; expected success', 'the job e2e ended with cancelled; expected success', 'the job odd ended with no result; expected success']);
  assert.equal(result.lines.at(-1), '[ci-passed] failed: 4 of 5 needed jobs did not succeed');
});

test('ci-passed judges nothing, and fails with status 2, for input that names no job', () => {
  for (const [input, message] of [[undefined, /RESULTS is not set; the step passes the JSON of needs/], ['', /RESULTS is not set/], ['{oops', /RESULTS is not JSON: /], ['[]', /not a JSON object of jobs/], ['null', /not a JSON object of jobs/], ['{}', /RESULTS names no job: "\{\}"; list every other job of the workflow under needs/]]) {
    const result = passed(input);
    assert.equal(result.status, 2, String(input));
    assert.match(result.lines[0], message);
  }
});

test('the ci-passed command writes annotations on GitHub Actions only', () => {
  const run = env => spawnSync(process.execPath, [path.join(KIT, 'ci-passed.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const results = JSON.stringify({ a: { result: 'failure' } });
  const plain = run({ RESULTS: results });
  assert.equal(plain.status, 1);
  assert.doesNotMatch(plain.stdout, /::error/);
  const hosted = run({ RESULTS: results, GITHUB_ACTIONS: 'true' });
  assert.match(hosted.stdout, /::error title=ci-passed::the job a ended with failure; expected success/);
  assert.equal(run({}).status, 2);
  assert.equal(run({ RESULTS: JSON.stringify({ a: ok }) }).status, 0);
});
