// check runner와 owner-check의 단계 하나(scripts/check/run.mjs의 command)는 자기 임시 directory(TMPDIR)와 자기
// process group에서 실행된다. 통과한 단계가 임시 entry나 process를 남기면 그 단계는 실패하고, 실패한 단계가 남긴
// 임시 entry는 보고서로 복사된다. 어느 쪽이든 단계 뒤에는 남은 것이 없다. 각 case는 실제 sh로 단계를 실행한다.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, PROCESS } from '../../tests/testcase.mjs';
import { command } from './run.mjs';
import { endGroup } from './step.mjs';
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

caseTest('a passed step that leaves a process in its group fails and the process is killed', PROCESS, async () => {
  const work = mkdtempSync(join(tmpdir(), 'orm-step-test-'));
  const pidFile = join(work, 'pid');
  let pid;
  try {
    const { lines, step } = collect();
    const error = await run('sh', ['-c', `sleep 37 >/dev/null 2>&1 & echo $! > ${pidFile}`], step).then(() => null, error => error);
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
    await assert.rejects(run('sh', ['-c', `mkdir "$TMPDIR/out"; echo evidence > "$TMPDIR/out/result.txt"; sleep 38 >/dev/null 2>&1 & echo $! > ${pidFile}; exit 3`], step, () => {}, { keep }),
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
