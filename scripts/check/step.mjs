// runStep은 check runner(scripts/check/run.mjs)와 owner-check(scripts/features/owners.mjs)의 단계 하나를 실행한다.
// 단계는 자기 임시 directory와 자기 process group을 가진다.
//
// - 임시 directory: 시스템 임시 directory 아래에 단계마다 새로 만든 `orm-step-*`이고 TMPDIR로 준다. Go
//   os.TempDir, Rust env::temp_dir, PHP sys_get_temp_dir, Node os.tmpdir와 mktemp가 모두 TMPDIR을 따르므로,
//   단계가 만든 임시 file은 모두 그 안에 생긴다. 시스템 임시 directory 아래에 두는 것은 socket path 길이 한도
//   때문이다.
// - process group: 단계는 자기 group의 leader로 시작한다. daemon처럼 자기 session을 새로 여는 process는 group을
//   떠나므로 보이지 않는다. 이 한계는 AGENTS.md가 적는다.
//
// 단계가 끝나면 group에 남은 process를 적고 끝내며, 임시 directory에 남은 entry를 적는다. 통과한 단계가
// process나 entry를 남겼으면 그 단계는 실패한다. 통과한 실행은 자기가 만든 것을 남기지 않아야 하기 때문이다.
// 실패한 단계가 남긴 entry는 keep으로 보고서에 복사한다. 어느 쪽이든 임시 directory는 지운다. runner가
// signal로 끝나도 진행 중인 단계의 group을 끝낸다.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stepLines } from '../../tests/testcase.mjs';

// active는 진행 중인 단계의 process group id다. runner가 끝날 때 남은 group을 끝낸다.
const active = new Set();
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  process.on('exit', () => {
    for (const group of active) signalGroup(group, 'SIGKILL');
  });
  for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]])
    process.on(signal, () => {
      for (const group of active) signalGroup(group, 'SIGKILL');
      process.exit(128 + number);
    });
}

function signalGroup(group, signal) {
  try {
    process.kill(-group, signal);
  } catch {
    // group에 process가 없다.
  }
}

// groupProcesses는 process group의 살아 있는 process(pid와 명령)다. 이미 끝나 회수를 기다리는 process(Z)는 뺀다.
export function groupProcesses(group) {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,command='], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`ps exited with ${listed.status ?? listed.signal}: ${listed.stderr}`);
  const found = [];
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match && Number(match[2]) === group && !match[3].startsWith('Z')) found.push({ pid: Number(match[1]), command: match[4] });
  }
  return found;
}

// stopGroup은 group의 process에 SIGTERM을 보내고, 3초 안에 끝나지 않으면 SIGKILL을 보낸다.
async function stopGroup(group) {
  signalGroup(group, 'SIGTERM');
  for (let waited = 0; waited < 3000; waited += 100) {
    if (groupProcesses(group).length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  signalGroup(group, 'SIGKILL');
}

// runStep은 program을 실행하고 출력 줄을 step으로 내보낸다. label은 실패 줄의 이름, spawned는 시작한 process의
// id를 받고, keep(directory)은 실패한 단계의 임시 entry를 복사하는 함수다. leftovers()는 단계 밖에 남은 것을
// 더 찾는다(runner의 실행 directory). 통과하면 resolve하고, 실패하거나 남긴 것이 있으면 그 이유로 reject한다.
//
// setup 단계(servers, databases/*, ci/*)는 guard를 false로 준다: 그 단계는 시스템 임시 directory와 runner의 process
// group을 그대로 쓴다. 시작한 server는 단계보다 오래 살고, daemon으로 띄운 mysqld는 TMPDIR을 자기 tmpdir로 쓰므로
// 단계 뒤에 지울 directory를 줄 수 없기 때문이다.
export function runStep(program, args, { cwd, env, step, label = `${program} ${args.join(' ')}`, spawned = () => {}, keep, leftovers = () => [], guard = true }) {
  if (!guard) return plainStep(program, args, { cwd, env, step, spawned });
  install();
  const temporary = mkdtempSync(join(tmpdir(), 'orm-step-'));
  return new Promise((finish, fail) => {
    let child;
    try {
      // npm은 Node의 compile cache를 켜고, 그 cache는 따로 정하지 않으면 TMPDIR 아래의 node-compile-cache다. 그것은
      // test가 남긴 것이 아니라 실행끼리 함께 쓰는 npm의 cache이므로, 단계 전과 같은 시스템 임시 directory에 둔다.
      const compileCache = env.NODE_COMPILE_CACHE ?? join(tmpdir(), 'node-compile-cache');
      child = spawn(program, args, { cwd, env: { ...env, TMPDIR: temporary, NODE_COMPILE_CACHE: compileCache }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      fail(error);
      return;
    }
    const group = child.pid;
    if (group) active.add(group);
    spawned(child.pid);
    const lines = stepLines(step);
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    let exited;
    const closed = new Promise(resolve => child.on('close', resolve));
    let settled = false;
    child.on('error', error => {
      if (settled) return;
      settled = true;
      active.delete(group);
      rmSync(temporary, { recursive: true, force: true });
      fail(error);
    });
    child.on('exit', async (code, signal) => {
      if (settled) return;
      settled = true;
      exited = { code, signal };
      const problems = [];
      try {
        // 남은 process를 먼저 적고 끝낸다. 그 process가 출력 pipe를 쥐고 있으면 close가 오지 않기 때문이다.
        const processes = groupProcesses(group);
        if (processes.length) {
          problems.push(`check: ${label} left ${processes.length} processes: ${processes.map(({ pid, command }) => `${pid} ${command}`).join(', ')}`);
          await stopGroup(group);
        }
        active.delete(group);
        await closed;
        lines.flush();
        const entries = readdirSync(temporary).sort();
        if (entries.length) {
          problems.push(`check: ${label} left ${entries.length} temporary entries: ${entries.join(' ')}`);
          if (code !== 0 && keep) {
            try {
              keep(temporary);
            } catch (error) {
              problems.push(`check: ${label}: its temporary entries could not be kept: ${error.message}`);
            }
          }
        }
        for (const path of leftovers()) problems.push(`check: ${label} left ${path}`);
      } catch (error) {
        problems.push(`check: ${label}: its leftovers could not be checked: ${error.message}`);
      } finally {
        active.delete(group);
        rmSync(temporary, { recursive: true, force: true });
      }
      for (const problem of problems) step(problem);
      if (exited.code === 0 && problems.length === 0) finish();
      else if (exited.code === 0) fail(new Error(problems.join('\n')));
      else fail(new Error(`${program} ${args.join(' ')} exited with ${exited.code ?? `signal ${exited.signal}`}`));
    });
  });
}

// plainStep은 guard 없이 program을 실행하고 출력 줄을 step으로 내보낸다(setup 단계).
function plainStep(program, args, { cwd, env, step, spawned }) {
  return new Promise((finish, fail) => {
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    spawned(child.pid);
    const lines = stepLines(step);
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    child.on('error', fail);
    child.on('close', (code, signal) => {
      lines.flush();
      if (code === 0) finish();
      else fail(new Error(`${program} ${args.join(' ')} exited with ${code ?? `signal ${signal}`}`));
    });
  });
}
