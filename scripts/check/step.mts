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
// Entries left by a failed step are copied into the report with keep. Either way the temporary directory is deleted.
//
// A process is stopped by a request and its end is an event (docs/spec/feature-coverage.md FCV-18): the runner sends
// SIGTERM to the group, says what it waits for, and waits with no time limit for the close of the output of the step. It
// sends no SIGKILL, because the end of a process is not judged by time: a process that is still writing its state is not
// killed, and a process that ignores the request is named. An interrupted runner admits no step, sends SIGTERM to the
// groups of its steps and exits when those steps have ended and have been checked.
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import { stepLines, type Step } from '../../tests/testcase.mts';
import { errorCode, errorMessage } from '../../tests/errors.mts';

// active is the process group id of the in-progress step. The runner asks the remaining group to end when it finishes.
const active = new Set<number>();
// pending is the steps that have not settled; an interrupted runner exits after them.
const pending = new Set<Promise<void>>();
// interrupted is the exit status of the signal that interrupted the runner; no step is admitted after it.
let interrupted: number | undefined;
let installed = false;
function signalActiveGroups(signal: NodeJS.Signals): unknown[] {
  const errors: unknown[] = [];
  for (const group of active) {
    try { signalGroup(group, signal); }
    catch (error) {
      errors.push(error);
      console.error(`check: could not send ${signal} to process group ${group}: ${errorMessage(error)}`);
    }
  }
  return errors;
}
function install() {
  if (installed) return;
  installed = true;
  // A runner that exits while a group is active can only ask that group to end: an exit handler waits for nothing.
  process.on('exit', () => {
    if (signalActiveGroups('SIGTERM').length && (process.exitCode === undefined || process.exitCode === 0)) process.exitCode = 1;
  });
  for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]] as const)
    process.on(signal, () => {
      // A repeated signal finds the wait of the first one in progress and adds nothing to it.
      if (interrupted !== undefined) return;
      interrupted = 128 + number;
      const steps = pending.size;
      console.error(`check: ${signal}: no step is admitted; sent SIGTERM to the process ${steps === 1 ? 'group' : 'groups'} of ${steps} ${steps === 1 ? 'step' : 'steps'} and waits for them with no time limit`);
      signalActiveGroups('SIGTERM');
      // Each step settles when its process has exited and its group and its leftovers have been checked.
      void Promise.allSettled(pending).then(() => {
        process.exit(process.exitCode === undefined || process.exitCode === 0 ? interrupted : process.exitCode);
      });
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
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    throw error;
  }
}

// groupProcesses are the live processes (pid and command) of the process group. Processes that have already ended and are waiting to be reaped (Z) are excluded.
// T351: the table is read with a 256 MiB buffer, the bound kit's processTable uses; a failure names its error code (ENOBUFS when the buffer overflows).
export function groupProcesses(group: number, options: { maxBuffer?: number } = {}): { pid: number; command: string }[] {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,command='], { encoding: 'utf8', maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024 });
  if (listed.error || listed.status !== 0) throw new Error(`ps failed with ${(listed.error && errorCode(listed.error)) ?? listed.signal ?? `status ${listed.status}`}: ${listed.stderr}`);
  const found: { pid: number; command: string }[] = [];
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match && Number(match[2]) === group && !(match[3] ?? '').startsWith('Z')) found.push({ pid: Number(match[1]), command: match[4] ?? '' });
  }
  return found;
}

// members are the live processes of the group as `<pid> <command>`.
const members = (group: number): string[] => groupProcesses(group).map(({ pid, command }) => `${pid} ${command}`);

/**
 * stopGroup asks the processes of the group to end and waits for their end (FCV-18). It sends SIGTERM, gives `report` one
 * line with the group and the members that it waits for, and waits with no time limit for `ended`, the event that the
 * owner of the group has for its end: the close of the output of its child, which comes when every process that holds
 * that output has ended. It returns the members that are alive when the event has come: a process that ignores SIGTERM
 * and holds no output of the owner. They are named and not killed. A group that is already gone when the signal is sent
 * returns at once; after a signal that was sent, the event is awaited also when the listing already shows no member,
 * because the event, not the listing, is the end of the group.
 */
export async function stopGroup(group: number, ended: Promise<unknown>, report: (line: string) => void = line => { console.log(line); }): Promise<string[]> {
  // false: the group is already absent, or it is no group of a step.
  if (!signalGroup(group, 'SIGTERM')) return [];
  const waited = members(group);
  if (waited.length) report(`check: sent SIGTERM to process group ${group} and waits for its end with no time limit: ${waited.join(', ')}`);
  await ended;
  return members(group);
}

// endGroup records the processes left in the group after a process started in its own process group (detached spawn)
// and asks them to end (stopGroup). If nothing remains, the list is empty. Such a group leaves the step's group, so the step's check cannot see it. So the group
// is checked by the code that made it, and anything left behind is treated as a failure (`make repo-check` requires that).
// `ended` is the event that the caller has for the end of what the group holds, the close of the output of its child; a
// caller that has none gives none, and the request is then all that endGroup does. A member that is alive after the event
// is named in a line of `report`.
export async function endGroup(group: number | null | undefined, ended: Promise<unknown> = Promise.resolve(), report: (line: string) => void = line => { console.log(line); }): Promise<string[]> {
  if (!group) return [];
  let left: string[];
  try { left = members(group); }
  catch (error) {
    // The listing failed, so what is left is not known: the group is still asked to end.
    try { await stopGroup(group, ended, report); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `check: could not list or stop process group ${group}: ${errorMessage(error)}; ${errorMessage(cleanup)}`, { cause: cleanup }); }
    throw error;
  }
  if (left.length) {
    const alive = await stopGroup(group, ended, report);
    if (alive.length) report(`check: process group ${group} still has members after SIGTERM and the end of its output, and they are not killed: ${alive.join(', ')}`);
  }
  return left;
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

export function runStep(program: string, args: string[], options: StepOptions): Promise<void> {
  if (interrupted !== undefined) return Promise.reject(new Error('check: the runner was interrupted and admits no step; run the check again'));
  if (options.guard === false) return plainStep(program, args, { cwd: options.cwd, env: options.env, step: options.step, spawned: options.spawned ?? (() => {}) });
  install();
  const result = guardedStep(program, args, options);
  pending.add(result);
  const settled = () => { pending.delete(result); };
  result.then(settled, settled);
  return result;
}

// guardedStep is a step in its own temporary directory and its own process group.
function guardedStep(program: string, args: string[], { cwd, env, step, label = `${program} ${args.join(' ')}`, spawned = () => {}, keep, leftovers = () => [] }: StepOptions): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), 'orm-step-'));
  // The run directory of the step, which the step owns: the recipes of the step write into it, and the
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
    const cleanupErrors: unknown[] = [];
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
        // The remaining processes are recorded first and then asked to end; the wait for them is the close of the output
        // of the step, which comes when every process that holds it has ended.
        const processes = group ? await endGroup(group, closed, step) : [];
        if (group && processes.length) {
          problems.push(`check: ${label} left ${processes.length} processes: ${processes.join(', ')}`);
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
              cleanupErrors.push(error);
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
        cleanupErrors.push(error);
        problems.push(`check: ${label}: its leftovers could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        for (const path of [temporary, stepRun]) {
          try { rmSync(path, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
        }
      }
      for (const problem of problems) step(problem);
      const primary = exited.code === 0
        ? (problems.length ? new Error(problems.join('\n')) : undefined)
        : new Error(`${program} ${args.join(' ')} exited with ${exited.code ?? `signal ${exited.signal}`}`);
      if (primary === undefined && cleanupErrors.length === 0) finish();
      else if (cleanupErrors.length) {
        const causes = primary === undefined ? cleanupErrors : [primary, ...cleanupErrors];
        const message = [primary?.message, `cleanup failed: ${cleanupErrors.map(errorMessage).join('; ')}`].filter(Boolean).join('; ');
        fail(new AggregateError(causes, message, primary === undefined ? undefined : { cause: primary }));
      } else fail(primary);
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
