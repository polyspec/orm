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

async function runChild(source, args = []) {
  const dir = await mkdtemp(join(tmpdir(), 'orm-testcase-'));
  try {
    const file = join(dir, 'fixture.mjs');
    await writeFile(file, source);
    // 안쪽 node --test가 바깥 test runner의 자식으로 보고하지 않도록 NODE_TEST_CONTEXT를 뺀다.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [...args, file], { env });
      return { code: 0, stdout };
    } catch (error) {
      return { code: error.code, stdout: error.stdout };
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

caseTest('testcase/duration', COMPUTE, () => {
  assert.equal(duration(0.5), '500µs');
  assert.equal(duration(12), '12ms');
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
await runCase('fixture/stuck', 100, () => new Promise(() => {}));
`);
  assert.equal(code, 0, stdout);
  inOrder(stdout, ['RUN fixture/pass deadline=1m0s', `STEP fixture/pass ${elapsed}: first step`, `PASS fixture/pass ${elapsed}`]);
  inOrder(stdout, ['RUN fixture/fail deadline=1m0s', `FAIL fixture/fail ${elapsed}: fixture failure reason`]);
  inOrder(stdout, ['RUN fixture/signal deadline=100ms', `FAIL fixture/signal ${elapsed}: deadline 100ms exceeded`]);
  inOrder(stdout, ['RUN fixture/stuck deadline=100ms', `FAIL fixture/stuck ${elapsed}: deadline 100ms exceeded`]);
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
  inOrder(stdout, ['RUN fixture/section-crash deadline=1m0s', `FAIL fixture/section-crash ${elapsed}: the process ended inside the case; its error is above`]);
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
