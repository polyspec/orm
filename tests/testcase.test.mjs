// tests/testcase.mjs의 runCase와 caseTest가 case마다 시작, 단계, 결과와 경과 시간을 이
// 순서로 출력하고, 기한이 지난 case를 FAIL로 보고하는지 하위 process로 확인한다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { caseTest, COMPUTE, duration, PROCESS } from './testcase.mjs';

const harness = new URL('./testcase.mjs', import.meta.url).href;
const elapsed = 'elapsed=[0-9.]+(µs|ms|s|m[0-9.]+s)';

// inOrder는 output에 patterns가 이 순서로 한 줄씩 나타나는지 확인한다.
function inOrder(output, patterns) {
  const lines = output.split('\n').map(line => line.trim());
  let at = 0;
  for (const pattern of patterns) {
    const re = new RegExp(`^${pattern}$`);
    while (at < lines.length && !re.test(lines[at])) at++;
    assert.ok(at < lines.length, `no line matching ${pattern} in order\n${output}`);
    at++;
  }
}

// timeout은 멈춘 fixture가 이 test를 붙잡지 않도록 하위 process를 끝내는 시간(ms)이다.
async function runChild(source, args = [], timeout = 30_000) {
  const dir = await mkdtemp(join(tmpdir(), 'orm-testcase-'));
  try {
    const file = join(dir, 'fixture.mjs');
    await writeFile(file, source);
    // 안쪽 node --test가 바깥 test runner의 자식으로 보고하지 않도록 NODE_TEST_CONTEXT를 뺀다.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [...args, file], { env, timeout, killSignal: 'SIGKILL' });
      return { code: 0, stdout };
    } catch (error) {
      if (error.killed) throw new Error(`fixture did not exit within ${duration(timeout)}\n${error.stdout}`);
      return { code: error.code, stdout: error.stdout };
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

caseTest('testcase/duration', COMPUTE, () => {
  assert.equal(duration(0.5), '500µs');
  assert.equal(duration(12), '12ms');
  assert.equal(duration(0.9996), '1ms');
  assert.equal(duration(999.6), '1s');
  assert.equal(duration(1340), '1.34s');
  assert.equal(duration(60_000), '1m0s');
  assert.equal(duration(75_030), '1m15.03s');
  assert.equal(duration(3_600_000), '1h0m0s');
});

caseTest('testcase/runCase', PROCESS, async () => {
  const { code, stdout } = await runChild(`
import { runCase } from ${JSON.stringify(harness)};
await runCase('fixture/pass', 60000, ({ step }) => step('first step'));
await runCase('fixture/fail', 60000, () => { throw new Error('fixture failure reason'); });
await runCase('fixture/signal', 100, ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
console.log('after signal');
`);
  assert.equal(code, 0, stdout);
  inOrder(stdout, ['RUN fixture/pass deadline=1m0s', `STEP fixture/pass ${elapsed}: first step`, `PASS fixture/pass ${elapsed}`]);
  inOrder(stdout, ['RUN fixture/fail deadline=1m0s', `FAIL fixture/fail ${elapsed}: fixture failure reason`]);
  inOrder(stdout, ['RUN fixture/signal deadline=100ms', `FAIL fixture/signal ${elapsed}: deadline 100ms exceeded`, 'after signal']);
  // signal을 따르지 않고 timer, socket 같은 handle을 쥔 채 멈춘 case는 GRACE 뒤 process를 끝낸다.
  // 끝내지 않으면 그 handle이 process를 살려 둔다.
  const stuck = await runChild(`
import { runCase } from ${JSON.stringify(harness)};
await runCase('fixture/stuck', 100, () => new Promise(() => { setInterval(() => {}, 1000); }));
console.log('after stuck');
`);
  assert.equal(stuck.code, 1, stuck.stdout);
  inOrder(stuck.stdout, ['RUN fixture/stuck deadline=100ms', `FAIL fixture/stuck ${elapsed}: deadline 100ms exceeded and the case did not stop`]);
  assert.doesNotMatch(stuck.stdout, /after stuck/);
});

caseTest('testcase/runGroup', PROCESS, async () => {
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
  inOrder(stdout, ['RUN fixture/group group', `STEP fixture/group ${elapsed}: child one`, `STEP fixture/group ${elapsed}: child two`,
    `STEP fixture/group ${elapsed}: tail`, `PASS fixture/group ${elapsed}`]);
  assert.doesNotMatch(stdout, /STEP fixture\/group [^:]*: \n/);
  inOrder(stdout, ['RUN fixture/group-fail group', `FAIL fixture/group-fail ${elapsed}: group failure reason`]);
});

caseTest('testcase/sections', PROCESS, async () => {
  const { code, stdout } = await runChild(`
import { sections } from ${JSON.stringify(harness)};
const log = sections();
log.begin('fixture/section-pass', 60000);
log.step('section step');
log.end();
log.begin('fixture/section-fail', 60000);
log.end('2 check(s) failed');
log.begin('fixture/section-crash', 60000);
throw new Error('uncaught section error');
`);
  assert.notEqual(code, 0, stdout);
  inOrder(stdout, ['RUN fixture/section-pass deadline=1m0s', `STEP fixture/section-pass ${elapsed}: section step`, `PASS fixture/section-pass ${elapsed}`]);
  inOrder(stdout, ['RUN fixture/section-fail deadline=1m0s', `FAIL fixture/section-fail ${elapsed}: 2 check\\(s\\) failed`]);
  inOrder(stdout, ['RUN fixture/section-crash deadline=1m0s', `FAIL fixture/section-crash ${elapsed}: the process ended inside the case: uncaught section error`]);
  // 오류를 stderr에 적고 process.exit로 끝낸 구역의 FAIL 줄은 그 마지막 오류 줄을 담는다(scripts/git/check.mjs가 그렇게 끝난다).
  const exited = await runChild(`
import { sections } from ${JSON.stringify(harness)};
const log = sections();
log.begin('fixture/section-exit', 60000);
console.error('first problem');
console.error('git.subject-format: subject exceeds 50 characters');
process.exit(1);
`);
  assert.equal(exited.code, 1, exited.stdout);
  inOrder(exited.stdout, ['RUN fixture/section-exit deadline=1m0s', `FAIL fixture/section-exit ${elapsed}: the process ended inside the case: git.subject-format: subject exceeds 50 characters`]);
  const stuck = await runChild(`
import { sections } from ${JSON.stringify(harness)};
const log = sections();
log.begin('fixture/section-stuck', 100);
await new Promise(resolve => setTimeout(resolve, 60000));
`);
  assert.equal(stuck.code, 1, stuck.stdout);
  inOrder(stuck.stdout, ['RUN fixture/section-stuck deadline=100ms', `FAIL fixture/section-stuck ${elapsed}: deadline 100ms exceeded`]);
  assert.doesNotMatch(stuck.stdout, /process ended inside/);
});

// run-long case는 느리지만 정상인 build(출력 사이에 1.5초를 쉬고 0으로 끝나는 명령)가 기한 없이
// 끝까지 실행되어 출력 줄, 종료 코드 0과 PASS를 보고하는지, 실패한 명령은 종료 코드와 오류 출력을
// 보고하는지, 기한 인자는 받지 않는지 확인한다. 같은 build는 기한 1초의 run-case에서 실패한다.
caseTest('testcase/run-long', PROCESS, async () => {
  const runLongScript = new URL('./run-long.mjs', import.meta.url).pathname;
  const run = async args => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [runLongScript, ...args]);
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const slow = "console.log('compiling one'); setTimeout(() => { console.error('compiling two'); console.log('finished'); }, 1500)";
  const passed = await run(['fixture/slow-build', '--', process.execPath, '-e', slow]);
  assert.equal(passed.code, 0, passed.stdout);
  inOrder(passed.stdout, ['RUN fixture/slow-build no-deadline', `STEP fixture/slow-build ${elapsed}: compiling one`,
    `STEP fixture/slow-build ${elapsed}: compiling two`, `STEP fixture/slow-build ${elapsed}: finished`,
    `STEP fixture/slow-build ${elapsed}: exit 0`, `PASS fixture/slow-build ${elapsed}`]);
  assert.match(passed.stdout, /PASS fixture\/slow-build elapsed=(?:1\.[5-9][0-9]*|[2-9](?:\.[0-9]+)?)s\n/);
  const cwd = await mkdtemp(join(tmpdir(), 'orm-run-long-'));
  try {
    const moved = await run(['fixture/cwd', '--cwd', cwd, '--', process.execPath, '-e', 'console.log(process.cwd())']);
    assert.equal(moved.code, 0, moved.stdout);
    assert.ok(moved.stdout.includes(`: ${cwd}\n`) || moved.stdout.includes(`: /private${cwd}\n`), moved.stdout);
  } finally { await rm(cwd, { recursive: true, force: true }); }
  const failed = await run(['fixture/broken-build', '--', process.execPath, '-e', "console.error('error: missing symbol'); process.exit(3)"]);
  assert.equal(failed.code, 1, failed.stdout);
  inOrder(failed.stdout, ['RUN fixture/broken-build no-deadline', `STEP fixture/broken-build ${elapsed}: error: missing symbol`,
    `FAIL fixture/broken-build ${elapsed}: .* exited with 3`]);
  const deadline = await run(['fixture/deadline', '5m', '--', 'true']);
  assert.equal(deadline.code, 2, deadline.stdout);
  assert.match(deadline.stderr, /usage: node tests\/run-long\.mjs <name> \[--cwd <dir>\] -- /);
});

caseTest('testcase/caseTest', PROCESS, async () => {
  const { code, stdout } = await runChild(`
import { caseTest } from ${JSON.stringify(harness)};
caseTest('fixture/node-pass', 60000, ({ step }) => step('node step'));
caseTest('fixture/node-fail', 60000, () => { throw new Error('node failure reason'); });
`, ['--test', '--test-reporter=tap']);
  assert.notEqual(code, 0, stdout);
  inOrder(stdout, ['.*RUN fixture/node-pass deadline=1m0s', `.*STEP fixture/node-pass ${elapsed}: node step`, `.*PASS fixture/node-pass ${elapsed}`]);
  inOrder(stdout, ['.*RUN fixture/node-fail deadline=1m0s', `.*FAIL fixture/node-fail ${elapsed}: node failure reason`]);
});
