// check runner와 owner-check의 단계 하나(scripts/check/run.mjs의 command)는 자기 임시 directory(TMPDIR)와 자기
// process group에서 실행된다. 통과한 단계가 임시 entry나 process를 남기면 그 단계는 실패하고, 실패한 단계가 남긴
// 임시 entry는 보고서로 복사된다. 어느 쪽이든 단계 뒤에는 남은 것이 없다. 각 case는 실제 sh로 단계를 실행한다.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mjs';
import { isolatedEnvironment } from '../../tests/environment.mjs';
import { command } from './run.mjs';
import { endGroup, runStep } from './step.mjs';
import { spawn } from 'node:child_process';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const run = command(repo);

// step은 단계의 출력 줄을 모은다.
function collect() {
  const lines = [];
  return { lines, step: line => lines.push(line) };
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

caseTest('a step runs with a temporary directory of its own that is removed after it', PROCESS, async () => {
  const { lines, step } = collect();
  await run('sh', ['-c', 'echo "tmp=$TMPDIR"'], step);
  const seen = lines.map(line => /^tmp=(.*)$/.exec(line)?.[1]).find(Boolean);
  assert.ok(seen, `the step printed its TMPDIR: ${lines.join(' | ')}`);
  assert.notEqual(resolve(seen), resolve(tmpdir()));
  assert.equal(existsSync(seen), false, `${seen} is removed after the step`);
});

caseTest('a passed step that leaves a temporary entry fails and the entry is removed', PROCESS, async () => {
  const leftover = join(tmpdir(), 'orm-leftover-probe');
  try {
    const { lines, step } = collect();
    await assert.rejects(run('sh', ['-c', 'mkdir "${TMPDIR:-/tmp}/orm-leftover-probe" && echo "made $TMPDIR"'], step),
      /left 1 temporary entries: orm-leftover-probe/);
    const made = lines.map(line => /^made (.*)$/.exec(line)?.[1]).find(Boolean);
    assert.equal(existsSync(join(made, 'orm-leftover-probe')), false);
  } finally {
    rmSync(leftover, { recursive: true, force: true });
  }
});

// The forked child is named after the shell until it runs exec; the step waits for the exec of sleep.
const UNTIL_EXEC = 'until ps -o args= -p $! | grep -q "^sleep "; do :; done';

caseTest('a passed step that leaves a process in its group fails and the process is killed', PROCESS, async () => {
  const work = mkdtempSync(join(tmpdir(), 'orm-step-test-'));
  const pidFile = join(work, 'pid');
  let pid;
  try {
    const { lines, step } = collect();
    const error = await run('sh', ['-c', `sleep 37 >/dev/null 2>&1 & echo $! > ${pidFile}; ${UNTIL_EXEC}`], step).then(() => null, error => error);
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(error, 'the step fails');
    assert.match(error.message, new RegExp(`left 1 processes: ${pid} sleep 37`));
    assert.ok(lines.some(line => line.includes(`left 1 processes: ${pid} sleep 37`)), lines.join(' | '));
    assert.equal(alive(pid), false, `process ${pid} is killed`);
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(work, { recursive: true, force: true });
  }
});

caseTest('a failed step keeps its temporary entries in the report and leaves no process', PROCESS, async () => {
  const work = mkdtempSync(join(tmpdir(), 'orm-step-test-'));
  const keep = join(work, 'kept');
  const pidFile = join(work, 'pid');
  let pid;
  try {
    const { lines, step } = collect();
    await assert.rejects(run('sh', ['-c', `mkdir "$TMPDIR/out"; echo evidence > "$TMPDIR/out/result.txt"; sleep 38 >/dev/null 2>&1 & echo $! > ${pidFile}; ${UNTIL_EXEC}; exit 3`], step, () => {}, { keep }),
      /exited with 3/);
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(readFileSync(join(keep, 'out/result.txt'), 'utf8'), 'evidence\n');
    assert.ok(lines.some(line => /left 1 temporary entries: out/.test(line)), lines.join(' | '));
    assert.ok(lines.some(line => line.includes(`left 1 processes: ${pid} sleep 38`)), lines.join(' | '));
    assert.equal(alive(pid), false, `process ${pid} is killed`);
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(work, { recursive: true, force: true });
  }
});

caseTest("npm's compile cache stays in the system temporary directory and is not a leftover of the step", PROCESS, async () => {
  const { lines, step } = collect();
  await run('sh', ['-c', 'echo "cache=$NODE_COMPILE_CACHE"; npm --version'], step);
  // runner 안에서 실행하면 바깥 단계가 이미 정한 cache를 그대로 쓴다.
  const expected = process.env.NODE_COMPILE_CACHE ?? join(tmpdir(), 'node-compile-cache');
  assert.ok(lines.includes(`cache=${expected}`), lines.join(' | '));
});

caseTest('endGroup names and ends what a process of its own group left behind', PROCESS, async () => {
  const child = spawn('sh', ['-c', 'sleep 39 >/dev/null 2>&1 & echo $!'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  await new Promise(resolve => child.on('close', resolve));
  const pid = Number(out.trim());
  try {
    assert.deepEqual(await endGroup(child.pid), [`${pid} sleep 39`]);
    assert.equal(alive(pid), false, `process ${pid} is ended`);
    assert.deepEqual(await endGroup(child.pid), []);
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

// fake runner case(G5.77)는 runner 자리의 node process를 자기 group으로 시작하고, 그 안에서 단계의 group signal을
// 보낸다. 자기 group, group 0과 1, 음수에 보내는 signal은 거부되어 runner가 살아남고, 그 group에 그대로 보낸 signal은
// runner를 끝낸다(대조군). 단계가 남긴 process를 끝내는 runStep도 runner를 끝내지 않는다.
caseTest('a group signal never reaches the process group of the runner', PROCESS, async () => {
  const stepModule = new URL('./step.mjs', import.meta.url).pathname;
  const fake = (body) => new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { signalGroup, processGroupOf, runStep } from ${JSON.stringify(stepModule)};
      const own = processGroupOf(process.pid);
      ${body}
      console.log('alive');
    `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: isolatedEnvironment() });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, out }));
  });
  const guarded = await fake(`
    for (const group of [own, 0, 1, -5, process.pid]) signalGroup(group, 'SIGTERM');
    await runStep('sh', ['-c', 'sleep 41 >/dev/null 2>&1 & exit 0'], { cwd: process.cwd(), env: { PATH: process.env.PATH }, step: () => {}, label: 'fake' }).catch(() => {});
  `);
  assert.equal(guarded.signal, null, guarded.out);
  assert.match(guarded.out, /alive\n$/);
  assert.equal((guarded.out.match(/refused to send SIGTERM/g) ?? []).length, 5, guarded.out);
  const unguarded = await fake(`process.kill(-own, 'SIGTERM'); await new Promise(resolve => setTimeout(resolve, 1000));`);
  assert.equal(unguarded.signal, 'SIGTERM', 'a raw signal to the own group ends the runner');
});

// 단계 이름 case(G5.77)는 단계의 process가 .runtime/run에 단계 이름(ORM_STEP)을 담아 만든 directory를 runner가 단계의
// 잔여물로 찾아 지우는지 본다. tests/cargo-test.mjs의 test binary 복사본이 그 directory에 있다(CI의 /tmp는 memory를
// 쓰는 tmpfs이므로 복사본은 disk에 둔다).
caseTest('a run directory named after the step is a leftover of the step', PROCESS, async () => {
  const root = mkdtempSync(join(tmpdir(), 'orm-step-test-'));
  try {
    const { step } = collect();
    await assert.rejects(runStep('sh', ['-c', 'mkdir -p ".runtime/run/cargo-test-$ORM_STEP-1-x"'], { cwd: root, env: isolatedEnvironment(), step, label: 'named' }),
      /check: named left \.runtime\/run\/cargo-test-orm-step-\w+-1-x/);
    assert.deepEqual(readdirSync(join(root, '.runtime/run')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

caseTest('the resource lines list the processes with the largest resident memory', COMPUTE, async () => {
  const { topProcesses, resourceLines } = await import('./resources.mjs');
  assert.deepEqual(topProcesses(' 10  10  2048 mysqld\n 11  10 1024000 postgres\n 12 12 512 sh\n', 2), [
    { pid: 11, pgid: 10, rssMiB: 1000, command: 'postgres' }, { pid: 10, pgid: 10, rssMiB: 2, command: 'mysqld' }]);
  const lines = resourceLines(new Date(0));
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^RESOURCES 1970-01-01T00:00:00\.000Z memory /);
  assert.match(lines[3], /^RESOURCES group signals /);
});
