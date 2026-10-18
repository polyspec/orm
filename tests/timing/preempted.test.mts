// Each client's timing measures the CPU time its computation used, and performance is only measured and reported, never failing the test
// (AGENTS.md). This test alternately stops the process group with SIGSTOP and SIGCONT, so that on a shared machine it deterministically creates
// the state of waiting while another process uses the CPU. Each test must pass just as it does when not stopped, and its measurement is
// printed. The stop and resume cycle is set by a timer: a stopped process
// emits no event, so there is no other event source.
//
// Usage: make timing-check (the target builds the Go test binary, the Rust stress example and
// the TypeScript client, and writes the stress document first).
import { isolatedEnvironment } from '../environment.mts';
import { errorCode } from '../errors.mts';
import { caseTest, stepLines, type Step } from '../testcase.mts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { endGroup } from '../../scripts/check/step.mts';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Run 10 ms, stop 90 ms: the process gets one tenth of the wall-clock time as CPU, on 11 cores,
// a ratio similar to a shared machine with a load average of 90.
const RUN_MS = 10;
const STOP_MS = 90;
// TIMEOUT is the deadline for one case. The child process gets only one tenth of the wall-clock time as CPU, so
// a test that finishes in 1 minute without stopping takes up to 10 minutes.
const TIMEOUT = 600_000;

// TOOLCHAIN is the toolchain setting exported by the Makefile of make timing-check: cargo, go, npm and Composer use this value to use the same
// toolchain, target directory and offline execution.
const TOOLCHAIN = ['RUSTUP_TOOLCHAIN', 'CARGO_TARGET_DIR', 'CARGO_INCREMENTAL', 'CARGO_PROFILE_DEV_DEBUG', 'CARGO_NET_OFFLINE', 'GOPROXY', 'npm_config_offline', 'COMPOSER_DISABLE_NETWORK'];

function declared(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; make timing-check declares it`);
  return value;
}

// runPreempted runs the command in its own process group, and periodically stops that group,
// and returns the exit code, signal and output. The output lines of the child process come out as the case's steps during the run.
async function runPreempted(step: Step, command: string, args: string[], cwd: string) {
  step(`start ${command} ${args.join(' ')}`);
  const lines = stepLines(step);
  // The child process receives only the variables the case gives (tests/environment.mts): the toolchain setting (TOOLCHAIN) exported by the Makefile.
  // It also does not receive NODE_TEST_CONTEXT of the outer test runner, so the inner node --test does not report as a child of that runner.
  const env = isolatedEnvironment(Object.fromEntries(TOOLCHAIN.flatMap(name => { const value = process.env[name]; return value === undefined ? [] : [[name, value]]; })));
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += String(chunk); lines.write(String(chunk)); });
  child.stderr.on('data', (chunk: Buffer) => { output += String(chunk); lines.write(String(chunk)); });
  let exited = false;
  const exit = new Promise<void>((resolve) => child.on('exit', () => { exited = true; resolve(); }));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
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
  // The command was the leader of its own group. A process left in that group after it ends is a failure (endGroup).
  const left = await endGroup(child.pid);
  assert.deepEqual(left, [], `${command} left processes in its group`);
  step(`end ${command} code=${code} signal=${signal} stops=${stops}`);
  return { code, signal, output, stops };
}

// signalGroup returns false when the group has already ended. On macOS, for a leader that has ended but is not yet reaped,
// the group returns EPERM, so EPERM counts as the group having ended if
// the leader's exit event arrives within 1 second. Other failures are thrown as they are.
async function signalGroup(pid: number | undefined, signal: NodeJS.Signals, exit: Promise<void>): Promise<boolean> {
  if (pid === undefined) throw new Error('the child has no process id; it did not start');
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    if (errorCode(error) === 'EPERM' && (await Promise.race([exit.then(() => true), sleep(1000).then(() => false)]))) return false;
    throw error;
  }
}

async function passesPreempted(step: { (text: string): void; (text: string): void; (text: string): void; (text: string): void; (text: string): void; }, command: string, args: string[], cwd = root) {
  const { code, signal, output, stops } = await runPreempted(step, command, args, cwd);
  assert.ok(stops > 0, `${command} finished before it was stopped once`);
  assert.equal(signal, null, `${command} ended by ${signal}:\n${output}`);
  assert.equal(code, 0, `${command} failed while preempted:\n${output}`);
}

const stressDocument = () => declared('DBSPEC_STRESS_DOCUMENT');

caseTest('go: the stress test passes while preempted', TIMEOUT, async ({ step }) => {
  await passesPreempted(step, declared('TIMING_GO_DBSPEC_TEST'), ['-test.run', '^TestStressDocument$', '-test.count', '1', '-test.v'], `${root}packages/go/engine/dbspec`);
});

caseTest('rust: the stress test passes while preempted', TIMEOUT, async ({ step }) => {
  await passesPreempted(step, declared('TIMING_RUST_STRESS'), [stressDocument()]);
});

caseTest('rust: the polyspec-orm-schema vector tests pass while preempted', TIMEOUT, async ({ step }) => {
  const tests = ['dbspec', 'dbspec_rules', 'dbspec_manifest', 'dbspec_render', 'dbspec_runtime', 'dbspec_plan', 'dbspec_mermaid'];
  await passesPreempted(step, 'cargo', ['test', '--locked', '--offline', '-p', 'polyspec-orm-schema', ...tests.flatMap((name) => ['--test', name])], `${root}packages/rust`);
});

for (const test of ['DbspecTest', 'DbspecRulesTest', 'DbspecManifestTest', 'DbspecRenderTest', 'DbspecMermaidTest', 'DbspecPlanTest', 'DbspecStressTest']) {
  caseTest(`php: ${test} passes while preempted`, TIMEOUT, async ({ step }) => {
    await passesPreempted(step, 'php', ['vendor-php/bin/phpunit', '--configuration', 'packages/php/phpunit.xml.dist', `packages/php/tests/${test}.php`]);
  });
}

caseTest('typescript: the stress test passes while preempted', TIMEOUT, async ({ step }) => {
  await passesPreempted(step, process.execPath, ['--test', 'packages/ts/tests/dbspec-stress.mjs']);
});
