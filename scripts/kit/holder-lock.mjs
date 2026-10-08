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
// it. Only the holder releases the lock; the release checks the token first.
//
//   node scripts/kit/holder-lock.mjs run <lock> -- <command> [arguments...]
//     holds the lock while the command runs and exits with the status of the command (128 + n for signal n)
//   node scripts/kit/holder-lock.mjs clear <lock>
//     removes the lock when its holder has ended, and fails while the holder runs
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:os';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, ROOT } from './paths.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * The start time of a process from the text of `/proc/<pid>/stat` and the boot time of `/proc/stat`: field 22 counts clock
 * ticks from the boot. The command name in parentheses may hold spaces, so the fields are counted after its closing
 * parenthesis.
 */
export function procStart(stat, systemStat) {
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const boot = /^btime (\d+)$/m.exec(systemStat)?.[1];
  if (!/^\d+$/.test(ticks ?? '')) throw new Error(`/proc/<pid>/stat holds no start time: ${JSON.stringify(stat)}`);
  if (!boot) throw new Error('/proc/stat holds no boot time');
  return `${ticks} clock ticks after the boot at ${new Date(Number(boot) * 1000).toISOString()}`;
}

/**
 * The start time of a running process, or null when no such process runs: from `/proc` on Linux, whose minimal container
 * images have no `ps`, and as `ps` prints it elsewhere.
 */
export function processStart(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return null;
    if (error.code !== 'EPERM') throw error;
  }
  if (process.platform === 'linux') {
    let stat;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return procStart(stat, readFileSync('/proc/stat', 'utf8'));
  }
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

/** Whether the process that wrote the record still runs; a reused process ID has another start time. */
export const holderRunning = record => processStart(record.pid) === record.processStart;

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
export function readLockRecord(lock) {
  const text = readFileSync(lock, 'utf8');
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
  if (!start) throw new Error(`the start time of process ${process.pid} is unknown`);
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
 * Removes a lock whose holder has ended and returns its record; a running holder is refused. The lock is renamed aside
 * before its record is read again, so a lock that a new holder took in the meantime is put back and not removed.
 */
export function removeDeadLock(lock) {
  if (!path.isAbsolute(lock)) throw new Error(`the lock file ${lock} must be an absolute path`);
  const record = readLockRecord(lock);
  if (holderRunning(record)) throw refusal(lock, record);
  const aside = `${lock}.removing.${process.pid}.${randomBytes(8).toString('hex')}`;
  renameSync(lock, aside);
  const moved = readLockRecord(aside);
  if (moved.token !== record.token) {
    try {
      linkSync(aside, lock);
    } catch (error) {
      throw new Error(`${lock} was taken by ${describeHolder(moved)} during the removal and another process took it before it was restored; the record of that holder is in ${aside}`, { cause: error });
    }
    unlinkSync(aside);
    throw refusal(lock, moved);
  }
  unlinkSync(aside);
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
