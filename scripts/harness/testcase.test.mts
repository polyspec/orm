// Checks through a child process that runCase and caseTest in tests/testcase.mts write node:test output (TAP) for each case, that
// a process that ends inside a case ends with `Bail out!`, and that no clock fails a case.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { execFailure } from '../../tests/errors.mts';
import { caseTest, duration } from '../../tests/testcase.mts';

const harness = new URL('../../tests/testcase.mts', import.meta.url).href;

// inOrder checks that the output contains the patterns, one line each, in this order.
function inOrder(output: string, patterns: string[]) {
  const lines = output.split('\n').map((line: string) => line.trim());
  let at = 0;
  for (const pattern of patterns) {
    const re = new RegExp(`^${pattern}$`);
    while (at < lines.length && !re.test(lines[at] ?? '')) at++;
    assert.ok(at < lines.length, `no line matching ${pattern} in order\n${output}`);
    at++;
  }
}

// runChild runs the fixture in a node process of its own and returns its exit code and output when it has ended.
async function runChild(source: string, args: string[] = []): Promise<{ code: number | string | undefined; stdout: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'orm-testcase-'));
  try {
    const file = join(dir, 'fixture.mjs');
    await writeFile(file, source);
    // The inner node --test runs with an environment that has only the variables the case gives. Since it does not take the outer test runner's NODE_TEST_CONTEXT either,
    // it does not report as a child of that runner.
    const env = isolatedEnvironment();
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [...args, file], { env });
      return { code: 0, stdout };
    } catch (error) {
      const failure = execFailure(error);
      return { code: failure.code, stdout: failure.stdout };
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

caseTest('testcase/duration', () => {
  assert.equal(duration(0.5), '500µs');
  assert.equal(duration(12), '12ms');
  assert.equal(duration(0.9996), '1ms');
  assert.equal(duration(999.6), '1s');
  assert.equal(duration(1340), '1.34s');
  assert.equal(duration(60_000), '1m0s');
  assert.equal(duration(75_030), '1m15.03s');
  assert.equal(duration(3_600_000), '1h0m0s');
});

caseTest('testcase/runCase', async () => {
  const { code, stdout } = await runChild(`
import { runCase } from ${JSON.stringify(harness)};
await runCase('fixture/pass', ({ step }) => step('first step'));
await runCase('fixture/fail', () => { throw new Error('fixture failure reason'); });
console.log('after fail');
`);
  assert.equal(code, 0, stdout);
  inOrder(stdout, ['first step', 'ok - fixture/pass']);
  inOrder(stdout, ['not ok - fixture/fail', '# fixture failure reason', 'after fail']);
  assert.doesNotMatch(stdout, /elapsed=|RUN |STEP |PASS |FAIL /);
});

// A case ends when its work ends, and no clock fails it (T473): the fixture runs every timer of the process on a mock
// clock, moves that clock a week past the start of each case, and then lets the work end; each case passes, and its signal
// was not aborted. The test result therefore does not depend on the time that the machine gives the work.
caseTest('testcase/no clock fails a case', async () => {
  const { code, stdout } = await runChild(`
import { mock } from 'node:test';
import { cases, runCase, sections } from ${JSON.stringify(harness)};
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const week = 7 * 24 * 3600 * 1000;
const work = () => { let finish; const ended = new Promise(resolve => { finish = resolve; }); return { ended, finish }; };
const run = work();
const passed = runCase('fixture/long-case', async ({ signal }) => { await run.ended; if (signal.aborted) throw new Error('the clock aborted the case'); });
mock.timers.tick(week);
run.finish();
console.log('runCase passed', await passed);
const log = sections();
log.begin('fixture/long-section');
mock.timers.tick(week);
log.end();
const runner = cases();
const native = work();
const registered = runner.run('fixture/long-native', async ({ signal }) => { await native.ended; if (signal.aborted) throw new Error('the clock aborted the case'); });
mock.timers.tick(week);
native.finish();
console.log('cases passed', await registered, 'finish', runner.finish());
`, ['--test', '--test-reporter=tap']);
  assert.equal(code, 0, stdout);
  inOrder(stdout, ['ok - fixture/long-case', 'runCase passed true', 'ok - fixture/long-section']);
  assert.match(stdout, /ok \d+ - fixture\/long-native/);
  assert.match(stdout, /cases passed true finish 0/);
  assert.doesNotMatch(stdout, /deadline|Bail out!/);
});

caseTest('testcase/runGroup', async () => {
  const { code, stdout } = await runChild(`
import { runGroup, stepLines } from ${JSON.stringify(harness)};
await runGroup('fixture/group', ({ step }) => {
  const lines = stepLines(step);
  lines.write('child one\\n\\nchild ');
  lines.write('two\\ntail');
  lines.flush();
});
await runGroup('fixture/group-fail', () => { throw new Error('group failure reason'); });
`);
  assert.equal(code, 0, stdout);
  inOrder(stdout, ['child one', 'child two', 'tail', 'ok - fixture/group']);
  assert.doesNotMatch(stdout, /\n\n/);
  inOrder(stdout, ['not ok - fixture/group-fail', '# group failure reason']);
});

caseTest('testcase/sections', async () => {
  const { code, stdout } = await runChild(`
import { sections } from ${JSON.stringify(harness)};
const log = sections();
log.begin('fixture/section-pass');
log.step('section step');
log.end();
log.begin('fixture/section-fail');
log.end('2 check(s) failed');
log.begin('fixture/section-crash');
throw new Error('uncaught section error');
`);
  assert.notEqual(code, 0, stdout);
  inOrder(stdout, ['section step', 'ok - fixture/section-pass']);
  inOrder(stdout, ['not ok - fixture/section-fail', '# 2 check\\(s\\) failed']);
  inOrder(stdout, ['Bail out! fixture/section-crash: the process ended inside the case: uncaught section error']);
  // The Bail out! line of a section whose error was written to stderr and which ended with process.exit contains that last error line (scripts/git/check.mts ends that way).
  const exited = await runChild(`
import { sections } from ${JSON.stringify(harness)};
const log = sections();
log.begin('fixture/section-exit');
console.error('first problem');
console.error('git.subject-format: subject exceeds 50 characters');
process.exit(1);
`);
  assert.equal(exited.code, 1, exited.stdout);
  inOrder(exited.stdout, ['Bail out! fixture/section-exit: the process ended inside the case: git.subject-format: subject exceeds 50 characters']);
});

// The run-long case checks that a slow but normal build (a command that waits 1.5 s between output lines and ends with 0) runs to the end with no deadline,
// shows its output lines as they are, and reports exit code 0 and `ok`; that a failed command reports its exit code and error output,
// and that it does not accept a deadline argument.
caseTest('testcase/run-long', async () => {
  const runLongScript = new URL('../../tests/run-long.mts', import.meta.url).pathname;
  const run = async (args: string[]) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [runLongScript, ...args]);
      return { code: 0, stdout, stderr };
    } catch (error) {
      const { code, stdout, stderr } = execFailure(error);
      return { code, stdout, stderr };
    }
  };
  const slow = "console.log('compiling one'); setTimeout(() => { console.error('compiling two'); console.log('finished'); }, 1500)";
  const passed = await run(['fixture/slow-build', '--', process.execPath, '-e', slow]);
  assert.equal(passed.code, 0, passed.stdout);
  inOrder(passed.stdout, ['compiling one', 'compiling two', 'finished', 'exit 0', 'ok - fixture/slow-build']);
  assert.doesNotMatch(passed.stdout, /elapsed=|RUN |PASS /);
  const cwd = await mkdtemp(join(tmpdir(), 'orm-run-long-'));
  try {
    const moved = await run(['fixture/cwd', '--cwd', cwd, '--', process.execPath, '-e', 'console.log(process.cwd())']);
    assert.equal(moved.code, 0, moved.stdout);
    assert.ok(moved.stdout.includes(`${cwd}\n`) || moved.stdout.includes(`/private${cwd}\n`), moved.stdout);
  } finally { await rm(cwd, { recursive: true, force: true }); }
  const failed = await run(['fixture/broken-build', '--', process.execPath, '-e', "console.error('error: missing symbol'); process.exit(3)"]);
  assert.equal(failed.code, 1, failed.stdout);
  inOrder(failed.stdout, ['error: missing symbol', 'not ok - fixture/broken-build', '# .* exited with 3']);
  const deadline = await run(['fixture/deadline', '5m', '--', 'true']);
  assert.equal(deadline.code, 2, deadline.stdout);
  assert.match(deadline.stderr, /usage: node tests\/run-long\.mts <name> \[--cwd <dir>\] -- /);
});

caseTest('testcase/caseTest', async () => {
  const { code, stdout } = await runChild(`
import { caseTest } from ${JSON.stringify(harness)};
caseTest('fixture/node-pass', ({ step }) => step('node step'));
caseTest('fixture/node-fail', () => { throw new Error('node failure reason'); });
`, ['--test', '--test-reporter=tap']);
  assert.notEqual(code, 0, stdout);
  inOrder(stdout, ['.*ok 1 - fixture/node-pass', '# node step', '.*not ok 2 - fixture/node-fail', `.*error: 'node failure reason'`]);
  assert.doesNotMatch(stdout, /RUN |PASS |FAIL |elapsed=/);
});

caseTest('testcase/cases registers each run as a native test and ignores filtered skips', async () => {
  const failing = await runChild(`
import { cases } from ${JSON.stringify(harness)};
const runner = cases();
const first = await runner.run('fixture/first', ({ step }) => { console.log('body:first'); step('first step'); });
const second = await runner.run('fixture/second', () => { console.log('body:second'); throw new Error('second failure'); });
console.log('results', first, second, 'finish', runner.finish());
`, ['--test', '--test-reporter=tap']);
  assert.equal(failing.code, 1, failing.stdout);
  assert.match(failing.stdout, /not ok 2 - fixture\/second/);
  assert.match(failing.stdout, /error: 'second failure'/);
  assert.match(failing.stdout, /results true false finish 1/);
  assert.doesNotMatch(failing.stdout, /(?:^|\n)ok - fixture\/|(?:^|\n)not ok - fixture\//);
  assert.ok(failing.stdout.indexOf('body:first') < failing.stdout.indexOf('body:second'), failing.stdout);

  const skipped = await runChild(`
import { cases } from ${JSON.stringify(harness)};
const runner = cases();
const chosen = await runner.run('fixture/chosen', () => {});
const omitted = await runner.run('fixture/omitted', () => { throw new Error('filtered body ran'); });
console.log('results', chosen, omitted, 'finish', runner.finish());
`, ['--test', '--test-reporter=tap', '--test-name-pattern=chosen']);
  assert.equal(skipped.code, 0, skipped.stdout);
  assert.match(skipped.stdout, /ok 1 - fixture\/chosen/);
  assert.match(skipped.stdout, /results true true finish 0/);
  assert.doesNotMatch(skipped.stdout, /fixture\/omitted|filtered body ran|case\(s\) failed|(?:^|\n)not ok - fixture\//);
});
