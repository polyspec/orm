// 각 client의 시간 측정은 그 계산이 쓴 CPU 시간을 재고, 성능은 측정해 보고할 뿐 test를 실패시키지 않는다
// (AGENTS.md). 이 test는 process group을 SIGSTOP과 SIGCONT로 번갈아 멈춰, 공유 machine에서 다른 process가 CPU를
// 쓰는 동안 기다리는 상태를 결정적으로 만든다. 각 test는 멈추지 않을 때와 같이 통과해야 하고, 그 측정은
// 출력된다. 멈춤과 재개 주기는 timer가 정한다: 멈춘 process는
// event를 내지 않으므로 다른 event source가 없다.
//
// Usage: make timing-check (the target builds the Go test binary, the Rust stress example and
// the TypeScript client, and writes the stress document first).
import { isolatedEnvironment } from '../environment.mjs';
import { caseTest, stepLines } from '../testcase.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { endGroup } from '../../scripts/check/step.mjs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
// 실행 10 ms, 멈춤 90 ms: process는 wall-clock 시간의 10분의 1만 CPU를 받는다. 11개 core에
// load average 90인 공유 machine과 비슷한 비율이다.
const RUN_MS = 10;
const STOP_MS = 90;
// TIMEOUT은 case 하나의 기한이다. 하위 process는 wall-clock 시간의 10분의 1만 CPU를 받으므로
// 멈추지 않을 때 1분 안에 끝나는 test가 10분까지 걸린다.
const TIMEOUT = 600_000;

// TOOLCHAIN은 make timing-check의 Makefile이 export하는 toolchain 설정이다: cargo, go, npm과 Composer는 이 값으로 같은
// toolchain, target directory와 offline 실행을 쓴다.
const TOOLCHAIN = ['RUSTUP_TOOLCHAIN', 'CARGO_TARGET_DIR', 'CARGO_INCREMENTAL', 'CARGO_PROFILE_DEV_DEBUG', 'CARGO_NET_OFFLINE', 'GOPROXY', 'npm_config_offline', 'COMPOSER_DISABLE_NETWORK'];

function declared(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; make timing-check declares it`);
  return value;
}

// runPreempted는 command를 자기 process group에서 실행하며 그 group을 주기적으로 멈추고
// 종료 code, signal, 출력을 돌려준다. 하위 process의 출력 줄은 실행 중에 case의 단계로 나온다.
async function runPreempted(step, command, args, cwd) {
  step(`start ${command} ${args.join(' ')}`);
  const lines = stepLines(step);
  // 하위 process는 case가 주는 변수만 받는다(tests/environment.mjs): Makefile이 export하는 toolchain 설정(TOOLCHAIN)이다.
  // 바깥 test runner의 NODE_TEST_CONTEXT도 받지 않으므로 안쪽 node --test는 그 runner의 자식으로 보고하지 않는다.
  const env = isolatedEnvironment(Object.fromEntries(TOOLCHAIN.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])));
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; lines.write(String(chunk)); });
  child.stderr.on('data', (chunk) => { output += chunk; lines.write(String(chunk)); });
  let exited = false;
  const exit = new Promise((resolve) => child.on('exit', () => { exited = true; resolve(); }));
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  let stops = 0;
  while (!exited) {
    await sleep(RUN_MS);
    if (exited || !(await signalGroup(child.pid, 'SIGSTOP', exit))) break;
    stops++;
    await sleep(STOP_MS);
    if (!(await signalGroup(child.pid, 'SIGCONT', exit))) break;
  }
  const { code, signal } = await done;
  lines.flush();
  // command는 자기 group의 leader였다. 끝난 뒤 그 group에 남은 process는 실패다(endGroup).
  const left = await endGroup(child.pid);
  assert.deepEqual(left, [], `${command} left processes in its group`);
  step(`end ${command} code=${code} signal=${signal} stops=${stops}`);
  return { code, signal, output, stops };
}

// signalGroup은 group이 이미 끝났으면 false를 돌려준다. macOS는 끝났지만 아직 회수되지 않은
// leader의 group에 EPERM을 돌려주므로, EPERM은 1초 안에 leader의 exit event가 오면 끝난
// group으로 본다. 다른 실패는 그대로 던진다.
async function signalGroup(pid, signal, exit) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM' && (await Promise.race([exit.then(() => true), sleep(1000).then(() => false)]))) return false;
    throw error;
  }
}

async function passesPreempted(step, command, args, cwd = root) {
  const { code, signal, output, stops } = await runPreempted(step, command, args, cwd);
  assert.ok(stops > 0, `${command} finished before it was stopped once`);
  assert.equal(signal, null, `${command} ended by ${signal}:\n${output}`);
  assert.equal(code, 0, `${command} failed while preempted:\n${output}`);
}

const stressDocument = () => declared('DBSPEC_STRESS_DOCUMENT');

caseTest('go: the stress test passes while preempted', TIMEOUT, async ({ step }) => {
  await passesPreempted(step, declared('TIMING_GO_DBSPEC_TEST'), ['-test.run', '^TestStressDocument$', '-test.count', '1', '-test.v'], `${root}engine/dbspec`);
});

caseTest('rust: the stress test passes while preempted', TIMEOUT, async ({ step }) => {
  await passesPreempted(step, declared('TIMING_RUST_STRESS'), [stressDocument()]);
});

caseTest('rust: the polyspec-orm-schema vector tests pass while preempted', TIMEOUT, async ({ step }) => {
  const tests = ['dbspec', 'dbspec_rules', 'dbspec_manifest', 'dbspec_render', 'dbspec_runtime', 'dbspec_plan', 'dbspec_mermaid'];
  await passesPreempted(step, 'cargo', ['test', '--locked', '--offline', '-p', 'polyspec-orm-schema', ...tests.flatMap((name) => ['--test', name])], `${root}packages/orm-rust`);
});

for (const script of ['dbspec_test', 'dbspec_rules_test', 'dbspec_manifest_test', 'dbspec_render_test', 'dbspec_mermaid_test', 'dbspec_plan_test', 'dbspec_stress_test']) {
  caseTest(`php: ${script} passes while preempted`, TIMEOUT, async ({ step }) => {
    await passesPreempted(step, 'php', [`packages/orm-php/tests/${script}.php`]);
  });
}

caseTest('typescript: the stress test passes while preempted', TIMEOUT, async ({ step }) => {
  await passesPreempted(step, process.execPath, ['--test', 'packages/orm-npm/tests/dbspec-stress.mjs']);
});
