// runStep runs one step of the check runner (scripts/check/run.mts) and of owner-check (scripts/features/owners.mts).
// A step has its own temporary directory and its own process group.
//
// - temporary directory: a fresh `orm-step-*` under the system temporary directory for each step, given as TMPDIR. Go
//   os.TempDir, Rust env::temp_dir, PHP sys_get_temp_dir, Node os.tmpdir and mktemp all follow TMPDIR, so
//   every temporary file a step creates lands inside it. Keeping it under the system temporary directory is for the socket path
//   length limit.
// - process group: a step starts as the leader of its own group. A process that opens a new session of its own, like a daemon, leaves the group
//   and so is not visible. AGENTS.md records this limit.
//
// When a step ends, it records and ends the processes left in the group, and records the entries left in the temporary directory. A passing step
// that leaves a process or entry fails. A passing run must not leave behind what it made.
// Entries left by a failed step are copied into the report with keep. Either way the temporary directory is deleted. The runner
// ends the group of the in-progress step even when it ends by signal.
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import { stepLines, type Step } from '../../tests/testcase.mts';

// active is the process group id of the in-progress step. It ends the remaining group when the runner finishes.
const active = new Set<number>();
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  process.on('exit', () => {
    for (const group of active) signalGroup(group, 'SIGKILL');
  });
  for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]] as const)
    process.on(signal, () => {
      for (const group of active) signalGroup(group, 'SIGKILL');
      process.exit(128 + number);
    });
}

// ownGroup is this process's process group. The signal that ends a step's group must not reach this process's group (and the group
// shared with the runner and GitHub Actions); signalGroup compares for this.
let ownGroup: number | null | undefined;
export function processGroupOf(pid: number): number | null {
  const listed = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  const group = Number(listed.stdout.trim());
  return Number.isInteger(group) && group > 0 ? group : null;
}

// signals is the record of group signals sent (resources.mts prints it every 30 seconds).
export const signals: string[] = [];

// signalGroup sends a signal to a step's process group. Groups of 1 or lower (which mean all processes or one's own group) and
// this process's own group are not signaled, and that fact is recorded: such a signal would end the runner and the job that ran it.
export function signalGroup(group: number, signal: NodeJS.Signals): boolean {
  ownGroup ??= processGroupOf(process.pid);
  if (!Number.isInteger(group) || group <= 1 || group === ownGroup || group === process.pid) {
    signals.push(`refused ${signal} to group ${group} (own group ${ownGroup})`);
    console.log(`check: refused to send ${signal} to process group ${group}, which is not a step's own group (this process is in group ${ownGroup})`);
    return false;
  }
  signals.push(`${signal} -${group}`);
  try {
    process.kill(-group, signal);
    return true;
  } catch {
    // The group has no processes.
    return false;
  }
}

// groupProcesses are the live processes (pid and command) of the process group. Processes that have already ended and are waiting to be reaped (Z) are excluded.
export function groupProcesses(group: number): { pid: number; command: string }[] {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,command='], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`ps exited with ${listed.status ?? listed.signal}: ${listed.stderr}`);
  const found: { pid: number; command: string }[] = [];
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match && Number(match[2]) === group && !(match[3] ?? '').startsWith('Z')) found.push({ pid: Number(match[1]), command: match[4] ?? '' });
  }
  return found;
}

// stopGroup sends SIGTERM to the group's processes and sends SIGKILL if they have not ended within 3 seconds.
async function stopGroup(group: number): Promise<void> {
  signalGroup(group, 'SIGTERM');
  for (let waited = 0; waited < 3000; waited += 100) {
    if (groupProcesses(group).length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  signalGroup(group, 'SIGKILL');
}

// endGroup records the processes left in the group after a process started in its own process group (detached spawn)
// ends them. If nothing remains, the list is empty. Such a group leaves the step's group, so the step's check cannot see it. So the group
// is checked by the code that made it, and anything left behind is treated as a failure (`make repo-check` requires that).
export async function endGroup(group: number | null | undefined): Promise<string[]> {
  if (!group) return [];
  const processes = groupProcesses(group);
  if (processes.length) await stopGroup(group);
  return processes.map(({ pid, command }) => `${pid} ${command}`);
}

// runStep runs a program and emits its output lines as steps. label is the name on failure lines, and spawned takes the id of the process that was started,
// and keep (directory) is the function that copies the temporary entries of a failed step. leftovers() finds what remains outside the step
// (the runner's run directory). It resolves on pass; on failure, or if something was left behind, it rejects with that reason.
//
// Setup steps (servers, databases/*, ci/*) give guard as false: those steps use the system temporary directory and the runner's process
// group as is. A started server outlives the step, and a mysqld started as a daemon uses TMPDIR as its tmpdir, so
// the directory cannot be given to be removed after the step.
/** The options of runStep. */
export type StepOptions = {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  step: Step;
  label?: string;
  spawned?: (pid: number | undefined) => void;
  keep?: (directory: string) => void;
  leftovers?: () => string[];
  guard?: boolean;
};

export function runStep(program: string, args: string[], { cwd, env, step, label = `${program} ${args.join(' ')}`, spawned = () => {}, keep, leftovers = () => [], guard = true }: StepOptions): Promise<void> {
  if (!guard) return plainStep(program, args, { cwd, env, step, spawned });
  install();
  const temporary = mkdtempSync(join(tmpdir(), 'orm-step-'));
  // The run directory of the step, which the step owns: the recipes of the step (parity-prepare) write into it, and the
  // runner removes it when the step ends, pass or fail, before it looks for leftovers.
  const stepRun = join(cwd ?? '.', '.runtime/run', basename(temporary));
  mkdirSync(stepRun, { recursive: true });
  return new Promise<void>((finish, fail) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      // npm turns on Node's compile cache, which, unless set otherwise, is node-compile-cache under TMPDIR. That is not
      // something a test left behind but an npm cache shared between runs, so it stays in the same system temporary directory as before the step.
      const compileCache = env.NODE_COMPILE_CACHE ?? join(tmpdir(), 'node-compile-cache');
      child = spawn(program, args, { cwd, env: { ...env, TMPDIR: temporary, NODE_COMPILE_CACHE: compileCache, ORM_STEP: basename(temporary), STEP_RUN_DIR: stepRun }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true }); rmSync(stepRun, { recursive: true, force: true });
      fail(error);
      return;
    }
    const group = child.pid;
    if (group) active.add(group);
    spawned(child.pid);
    const lines = stepLines(step);
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    const closed = new Promise<void>(resolve => child.on('close', () => resolve()));
    let settled = false;
    child.on('error', error => {
      if (settled) return;
      settled = true;
      if (group) active.delete(group);
      rmSync(temporary, { recursive: true, force: true }); rmSync(stepRun, { recursive: true, force: true });
      fail(error);
    });
    child.on('exit', async (code, signal) => {
      if (settled) return;
      settled = true;
      const exited = { code, signal };
      const problems: string[] = [];
      try {
        // The remaining processes are recorded first and then ended. If such a process holds the output pipe, close does not arrive.
        const processes = group ? groupProcesses(group) : [];
        if (group && processes.length) {
          problems.push(`check: ${label} left ${processes.length} processes: ${processes.map(({ pid, command }) => `${pid} ${command}`).join(', ')}`);
          await stopGroup(group);
        }
        if (group) active.delete(group);
        await closed;
        rmSync(stepRun, { recursive: true, force: true });
        lines.flush();
        const entries = readdirSync(temporary).sort();
        if (entries.length) {
          problems.push(`check: ${label} left ${entries.length} temporary entries: ${entries.join(' ')}`);
          if (code !== 0 && keep) {
            try {
              keep(temporary);
            } catch (error) {
              problems.push(`check: ${label}: its temporary entries could not be kept: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        for (const path of leftovers()) problems.push(`check: ${label} left ${path}`);
        // A run directory that a step's process created in .runtime/run with the step name (ORM_STEP) (tests/cargo-test.mts) is also a leftover
        // the step left behind. A process ended by signal cannot delete it.
        const runs = join(cwd ?? '.', '.runtime/run');
        for (const entry of existsSync(runs) ? readdirSync(runs).filter(name => name.includes(`-${basename(temporary)}-`)) : []) {
          problems.push(`check: ${label} left .runtime/run/${entry}`);
          rmSync(join(runs, entry), { recursive: true, force: true });
        }
      } catch (error) {
        problems.push(`check: ${label}: its leftovers could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (group) active.delete(group);
        rmSync(temporary, { recursive: true, force: true }); rmSync(stepRun, { recursive: true, force: true });
      }
      for (const problem of problems) step(problem);
      if (exited.code === 0 && problems.length === 0) finish();
      else if (exited.code === 0) fail(new Error(problems.join('\n')));
      else fail(new Error(`${program} ${args.join(' ')} exited with ${exited.code ?? `signal ${exited.signal}`}`));
    });
  });
}

// plainStep runs the program without a guard and emits its output lines as the step (setup stage).
function plainStep(program: string, args: string[], { cwd, env, step, spawned }: { cwd?: string | undefined; env: NodeJS.ProcessEnv; step: Step; spawned: (pid: number | undefined) => void }): Promise<void> {
  return new Promise<void>((finish, fail) => {
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
