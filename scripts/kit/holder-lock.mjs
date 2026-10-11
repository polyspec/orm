#!/usr/bin/env node
// The holder lock of a resource that exists once, such as the record of the full run of a checkout or the fixed ports of a
// local server.
//
// A lock is one file. Its record names the holder: the checkout, the process ID, the start time of that process, the time
// the lock was taken, the command and a random token. The record is written completely to a file of its own and linked to
// the lock path; the link fails when the lock exists, so the lock appears atomically with its whole record and a reader
// never sees a partial record. One process holds a lock at a time. Another process fails with the record of the holder.
// The start time identifies the holder: a process ID that the system reuses has another start time, so the lock of an
// ended holder is not taken for a running one. A lock whose holder has ended is reported and stays until `clear` removes
// it; `clear` claims the lock by a hard link before it removes it and never moves the lock of a running holder. Only the
// holder releases the lock; the release checks the token first.
//
//   node scripts/kit/holder-lock.mjs run <lock> -- <command> [arguments...]
//     holds the lock while the command runs and exits with the status of the command (128 + n for signal n)
//   node scripts/kit/holder-lock.mjs clear <lock>
//     removes the lock when its holder has ended, and fails while the holder runs
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:os';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, ROOT } from './paths.mjs';
import { execute } from './process.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** The start time of a process that runs but whose start time this process cannot read; such a holder counts as running. */
const START_UNREADABLE = Symbol('start time unreadable');

/**
 * The system calls that processStart makes: the platform, kill(pid, 0), the reading of a file and the running of a command.
 * A test passes another host to follow the path of another platform.
 */
export const HOST = { platform: process.platform, kill: pid => process.kill(pid, 0), readFile: file => readFileSync(file, 'utf8'), execute };

/**
 * The start time of a process from the text of `/proc/<pid>/stat` and the text of `/proc/sys/kernel/random/boot_id`: field
 * 22 counts clock ticks from the boot, and the boot ID names the boot. `btime` of `/proc/stat` is not used: it is derived
 * from the wall clock, so it moves when the clock is set. The command name in parentheses may hold spaces, so the fields
 * are counted after its closing parenthesis.
 */
export function procStart(stat, bootId) {
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const boot = bootId.trim();
  if (!/^\d+$/.test(ticks ?? '')) throw new Error(`/proc/<pid>/stat holds no start time: ${JSON.stringify(stat)}`);
  if (!boot) throw new Error('/proc/sys/kernel/random/boot_id holds no boot ID');
  return `${ticks} clock ticks after the boot ${boot}`;
}

/** Whether a process has the ID: kill(pid, 0) succeeds or fails with EPERM for an existing process and with ESRCH for none. */
function processExists(pid, host) {
  try {
    host.kill(pid);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

// The creation time of a process on Windows. Node has no call that reads it (GetProcessTimes) without a native addon, so
// Windows PowerShell 5.1, which every supported Windows ships as powershell.exe, reads it: Process.StartTime of .NET calls
// GetProcessTimes, and ToFileTimeUtc gives it as a FILETIME, exact and free of the time zone. wmic is not used: it is
// deprecated and no longer installed by default on Windows 11. The exit status 3 means no process has the ID, and 4 that
// the creation time cannot be read (a process of another user without the right to query it).
const windowsStartScript = pid => `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { exit 3 }; try { $t = $p.StartTime; if ($null -eq $t) { exit 4 }; $t.ToFileTimeUtc() } catch { exit 4 }`;

// Runs a command that prints the start time; `statuses` maps an exit status other than 0 to its result.
function commandStart(host, command, args, statuses, env) {
  const result = host.execute(command, args, { env });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status in statuses) return statuses[result.status];
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}: ${result.stderr.trim()}`);
  return result.stdout.trim() || null;
}

/**
 * The start time of a running process; null when no such process runs, and START_UNREADABLE when the process runs and its
 * start time cannot be read.
 *
 * - Linux: the boot ID with the start ticks, from `/proc`, since minimal container images have no `ps`. When
 *   `/proc/<pid>/stat` cannot be read (`hidepid` hides the processes of other users), kill(pid, 0) is asked again: ESRCH
 *   means the process ended, otherwise it runs.
 * - Windows: the creation time from PowerShell (windowsStartScript); Windows has no `ps`.
 * - macOS and other systems: `lstart` of `ps` in the C locale. Node reads the start time of another process on macOS only
 *   through sysctl `kern.proc.pid.<pid>` or `proc_pidinfo`, which need a native addon, and macOS has no `/proc`; `ps` is
 *   part of the base system.
 */
export function processStart(pid, host = HOST) {
  if (!processExists(pid, host)) return null;
  if (host.platform === 'linux') {
    let stat;
    try {
      stat = host.readFile(`/proc/${pid}/stat`);
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) throw error;
      return processExists(pid, host) ? START_UNREADABLE : null;
    }
    return procStart(stat, host.readFile('/proc/sys/kernel/random/boot_id'));
  }
  if (host.platform === 'win32') {
    const created = commandStart(host, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsStartScript(pid)], { 3: null, 4: START_UNREADABLE });
    if (typeof created === 'string' && !/^\d+$/.test(created)) throw new Error(`powershell.exe printed no creation time: ${JSON.stringify(created)}`);
    return typeof created === 'string' ? `${created} (the Windows FILETIME of the creation)` : created;
  }
  return commandStart(host, 'ps', ['-o', 'lstart=', '-p', String(pid)], { 1: null }, { ...process.env, LC_ALL: 'C' });
}

/** Whether the process that wrote the record still runs; a reused process ID has another start time. */
export function holderRunning(record, host = HOST) {
  const start = processStart(record.pid, host);
  return start === START_UNREADABLE || start === record.processStart;
}

/** Describes a holder by its process, its checkout and the time it took the lock. */
export const describeHolder = record => `process ${record.pid} (started ${record.processStart}) of the checkout ${record.checkout}, held since ${record.acquired} for ${JSON.stringify(record.command)}`;

/** The error of a lock that another holder has; `record` is the record of that holder. */
export class HolderLockRefused extends Error {
  constructor(message, record) {
    super(message);
    this.name = 'HolderLockRefused';
    this.record = record;
  }
}

/** The record of a lock file; a file that holds no record is an error and never a free lock. */
export const readLockRecord = lock => parseLockRecord(lock, readFileSync(lock, 'utf8'));

function parseLockRecord(lock, text) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error(`${lock} holds no lock record: ${JSON.stringify(text)}`);
  }
  for (const [field, type] of [['checkout', 'string'], ['pid', 'number'], ['processStart', 'string'], ['acquired', 'string'], ['command', 'string'], ['token', 'string']]) {
    if (typeof record?.[field] !== type) throw new Error(`${lock} has no ${field} of type ${type}: ${text.trim()}`);
  }
  return record;
}

function refusal(lock, record) {
  if (holderRunning(record)) return new HolderLockRefused(`${lock} is held by ${describeHolder(record)}; the holder releases it when its run ends`, record);
  return new HolderLockRefused(`${lock} is held by ${describeHolder(record)}, which has ended; remove the lock with \`node ${path.relative(process.cwd(), SCRIPT)} clear ${lock}\` after checking the resource`, record);
}

/**
 * Takes the lock and returns `{ lock, record, release }`; throws HolderLockRefused with the record of the holder when the
 * lock exists, also when its holder has ended. `checkout` names the checkout of the holder and `command` the command that it
 * runs. With `releaseOnSignals` (the default) the lock is also released when this process receives SIGINT, SIGTERM or
 * SIGHUP, which end the process with the status 128 + n; the lock is always released when the process exits.
 */
export function acquireHolderLock(lock, { checkout = process.cwd(), command = process.argv.slice(1).join(' '), releaseOnSignals = true } = {}) {
  if (!path.isAbsolute(lock)) throw new Error(`the lock file ${lock} must be an absolute path`);
  mkdirSync(path.dirname(lock), { recursive: true });
  const start = processStart(process.pid);
  if (typeof start !== 'string') throw new Error(`the start time of process ${process.pid} is unknown`);
  const record = { checkout: path.resolve(checkout), pid: process.pid, processStart: start, acquired: new Date().toISOString(), command, token: randomBytes(16).toString('hex') };
  const pending = `${lock}.${process.pid}.${record.token}`;
  writeFileSync(pending, `${JSON.stringify(record)}\n`, { flag: 'wx' });
  try {
    linkSync(pending, lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw refusal(lock, readLockRecord(lock));
  } finally {
    unlinkSync(pending);
  }
  let held = true;
  const handlers = new Map();
  const release = () => {
    if (!held) return;
    held = false;
    // A released lock leaves no handler behind, so a process may take and release locks many times.
    process.removeListener('exit', release);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    const current = readLockRecord(lock);
    if (current.token !== record.token) throw new Error(`${lock} was replaced while process ${process.pid} held it; it now names ${describeHolder(current)}`);
    unlinkSync(lock);
  };
  process.on('exit', release);
  if (releaseOnSignals) {
    for (const signal of SIGNALS) {
      const handler = () => {
        release();
        process.exit(128 + constants.signals[signal]);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  }
  return { lock, record, release };
}

/**
 * Removes a lock whose holder has ended and returns its record; a running holder is refused.
 *
 * 1. Read the record R and refuse a running holder.
 * 2. Claim the lock: link it to `<lock>.<first 32 hex digits of the SHA-256 of R>.clearing`. EEXIST refuses: the claim is
 *    another clear of the same holder, running or interrupted.
 * 3. Read the claim. A record other than R means that a new holder took the lock after another clear removed it: remove the
 *    claim and refuse.
 * 4. Otherwise remove the lock, then the claim.
 *
 * Only the holder and the one clear that holds the claim remove the lock, so between the claim and the removal the lock
 * still holds R, and the lock of a running holder is never moved. `afterCheck` and `afterClaim` run after steps 1 and 2; a
 * test interleaves other clears and holders there.
 */
export function removeDeadLock(lock, { afterCheck = () => {}, afterClaim = () => {} } = {}) {
  if (!path.isAbsolute(lock)) throw new Error(`the lock file ${lock} must be an absolute path`);
  const text = readFileSync(lock, 'utf8');
  const record = parseLockRecord(lock, text);
  if (holderRunning(record)) throw refusal(lock, record);
  afterCheck();
  const claim = `${lock}.${createHash('sha256').update(text).digest('hex').slice(0, 32)}.clearing`;
  try {
    linkSync(lock, claim);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${claim} exists: another clear of this holder is running or was interrupted; remove ${claim} after checking that no clear runs`, { cause: error });
    if (error.code === 'ENOENT') throw new Error(`${lock} was removed during the clear`, { cause: error });
    throw error;
  }
  afterClaim();
  const claimed = readFileSync(claim, 'utf8');
  if (claimed !== text) {
    unlinkSync(claim);
    throw refusal(lock, parseLockRecord(lock, claimed));
  }
  unlinkSync(lock);
  unlinkSync(claim);
  return record;
}

/** Runs a command with the streams of this process and resolves its exit status; the signals of this process go to it. */
export async function runCommand(command, args, { cwd } = {}) {
  const child = spawn(command, args, { stdio: 'inherit', cwd });
  const forward = signal => child.kill(signal);
  for (const signal of SIGNALS) process.on(signal, forward);
  try {
    return await new Promise((resolve) => {
      child.on('error', (error) => {
        process.stderr.write(`lock: ${command} did not start: ${error.message}\n`);
        resolve(127);
      });
      child.on('exit', (code, signal) => resolve(code ?? 128 + constants.signals[signal]));
    });
  } finally {
    for (const signal of SIGNALS) process.off(signal, forward);
  }
}

/** Runs a command while holding the lock and resolves the exit status of the command. */
export async function holdWhileRunning(lock, command, args, { checkout, cwd } = {}) {
  const held = acquireHolderLock(lock, { checkout, command: [command, ...args].join(' '), releaseOnSignals: false });
  process.stderr.write(`lock: acquired ${lock} (process ${process.pid})\n`);
  try {
    return await runCommand(command, args, { cwd });
  } finally {
    held.release();
    process.stderr.write(`lock: released ${lock}\n`);
  }
}

async function main(argv) {
  const [operation, lock, separator, command, ...args] = argv;
  if (operation === 'run' && lock && separator === '--' && command) {
    return holdWhileRunning(path.resolve(lock), command, args, { checkout: ROOT });
  }
  if (operation === 'clear' && lock && argv.length === 2) {
    const record = removeDeadLock(path.resolve(lock));
    process.stdout.write(`lock: removed ${lock} of ${describeHolder(record)}, which has ended\n`);
    return 0;
  }
  throw new Error('usage: node scripts/kit/holder-lock.mjs run <lock> -- <command> [arguments...] | clear <lock>');
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`lock: ${error.message}\n`);
    process.exitCode = 1;
  }
}
