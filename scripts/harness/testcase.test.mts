// tests/testcase.mts의 runCase와 caseTest가 case마다 node:test의 출력(TAP)을 쓰는지, 기한이 지난 case가
// `Bail out!`로 끝나는지 하위 process로 확인한다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { execFailure } from '../../tests/errors.mts';
import { caseTest, COMPUTE, duration, PROCESS } from '../../tests/testcase.mts';

const harness = new URL('../../tests/testcase.mts', import.meta.url).href;

// inOrder는 output에 patterns가 이 순서로 한 줄씩 나타나는지 확인한다.
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

// timeout은 멈춘 fixture가 이 test를 붙잡지 않도록 하위 process를 끝내는 시간(ms)이다.
async function runChild(source: string, args: string[] = [], timeout = 30_000): Promise<{ code: number | string | undefined; stdout: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'orm-testcase-'));
  try {
    const file = join(dir, 'fixture.mjs');
    await writeFile(file, source);
    // 안쪽 node --test는 case가 주는 변수만 가진 환경으로 실행한다: 바깥 test runner의 NODE_TEST_CONTEXT도 받지 않으므로
    // 그 runner의 자식으로 보고하지 않는다.
    const env = isolatedEnvironment();
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [...args, file], { env, timeout, killSignal: 'SIGKILL' });
      return { code: 0, stdout };
    } catch (error) {
      const failure = execFailure(error);
      if (failure.killed) throw new Error(`fixture did not exit within ${duration(timeout)}\n${failure.stdout}`);
      return { code: failure.code, stdout: failure.stdout };
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
  inOrder(stdout, ['first step', 'ok - fixture/pass']);
  inOrder(stdout, ['not ok - fixture/fail', '# fixture failure reason']);
  inOrder(stdout, ['not ok - fixture/signal', '# deadline 100ms exceeded', 'after signal']);
  assert.doesNotMatch(stdout, /elapsed=|RUN |STEP |PASS |FAIL /);
  // signal을 따르지 않고 timer, socket 같은 handle을 쥔 채 멈춘 case는 GRACE 뒤 process를 끝낸다.
  // 끝내지 않으면 그 handle이 process를 살려 둔다.
  const stuck = await runChild(`
import { runCase } from ${JSON.stringify(harness)};
await runCase('fixture/stuck', 100, () => new Promise(() => { setInterval(() => {}, 1000); }));
console.log('after stuck');
`);
  assert.equal(stuck.code, 1, stuck.stdout);
  inOrder(stuck.stdout, ['Bail out! fixture/stuck: deadline 100ms exceeded and the case did not stop']);
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
  inOrder(stdout, ['child one', 'child two', 'tail', 'ok - fixture/group']);
  assert.doesNotMatch(stdout, /\n\n/);
  inOrder(stdout, ['not ok - fixture/group-fail', '# group failure reason']);
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
  inOrder(stdout, ['section step', 'ok - fixture/section-pass']);
  inOrder(stdout, ['not ok - fixture/section-fail', '# 2 check\\(s\\) failed']);
  inOrder(stdout, ['Bail out! fixture/section-crash: the process ended inside the case: uncaught section error']);
  // 오류를 stderr에 적고 process.exit로 끝낸 구역의 Bail out! 줄은 그 마지막 오류 줄을 담는다(scripts/git/check.mts가 그렇게 끝난다).
  const exited = await runChild(`
import { sections } from ${JSON.stringify(harness)};
const log = sections();
log.begin('fixture/section-exit', 60000);
console.error('first problem');
console.error('git.subject-format: subject exceeds 50 characters');
process.exit(1);
`);
  assert.equal(exited.code, 1, exited.stdout);
  inOrder(exited.stdout, ['Bail out! fixture/section-exit: the process ended inside the case: git.subject-format: subject exceeds 50 characters']);
  const stuck = await runChild(`
import { sections } from ${JSON.stringify(harness)};
const log = sections();
log.begin('fixture/section-stuck', 100);
await new Promise(resolve => setTimeout(resolve, 60000));
`);
  assert.equal(stuck.code, 1, stuck.stdout);
  inOrder(stuck.stdout, ['Bail out! fixture/section-stuck: deadline 100ms exceeded']);
  assert.doesNotMatch(stuck.stdout, /process ended inside/);
});

// run-long case는 느리지만 정상인 build(출력 사이에 1.5초를 쉬고 0으로 끝나는 명령)가 기한 없이
// 끝까지 실행되어 출력 줄을 그대로 보이고 종료 코드 0과 `ok`를 보고하는지, 실패한 명령은 종료 코드와 오류 출력을
// 보고하는지, 기한 인자는 받지 않는지 확인한다.
caseTest('testcase/run-long', PROCESS, async () => {
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

caseTest('testcase/caseTest', PROCESS, async () => {
  const { code, stdout } = await runChild(`
import { caseTest } from ${JSON.stringify(harness)};
caseTest('fixture/node-pass', 60000, ({ step }) => step('node step'));
caseTest('fixture/node-fail', 60000, () => { throw new Error('node failure reason'); });
`, ['--test', '--test-reporter=tap']);
  assert.notEqual(code, 0, stdout);
  inOrder(stdout, ['.*ok 1 - fixture/node-pass', '# node step', '.*not ok 2 - fixture/node-fail', `.*error: 'node failure reason'`]);
  assert.doesNotMatch(stdout, /RUN |PASS |FAIL |elapsed=/);
});
