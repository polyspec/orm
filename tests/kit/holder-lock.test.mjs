// Tests of the holder lock (scripts/kit/holder-lock.mjs): one holder at a time, a refusal that names the holder, release by
// the holder only, a holder identified by its start time, and a lock of an ended holder that is reported and removed only
// by `clear`. Every test uses a directory of its own and real processes.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireHolderLock, holderRunning, processStart, procStart, readLockRecord, removeDeadLock } from '../../scripts/kit/holder-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../../scripts/kit/holder-lock.mjs');

// Runs the cleanups of a test in reverse order of registration: a holder ends before its directory is removed.
const cleanups = new WeakMap();
function onEnd(t, cleanup) {
  if (!cleanups.has(t)) {
    cleanups.set(t, []);
    t.after(async () => {
      for (const item of cleanups.get(t).reverse()) await item();
    });
  }
  cleanups.get(t).push(cleanup);
}

function workspace(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kit-holder-lock-'));
  onEnd(t, () => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Starts a process that holds the lock until its standard input closes; resolves once it holds the lock.
function holdLock(t, lock, options = {}) {
  const code = `const { acquireHolderLock } = await import(${JSON.stringify(TOOL)}); acquireHolderLock(${JSON.stringify(lock)}, ${JSON.stringify({ checkout: '/work/checkout', command: 'holder', ...options })}); process.stdout.write('held\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
  const ended = new Promise(resolve => child.once('exit', (status, signal) => resolve({ status, signal })));
  onEnd(t, async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    await ended;
  });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve({ child, ended }));
    child.once('exit', status => reject(new Error(`the holder exited with ${status}`)));
  });
}

// Writes the record of a process that has ended.
function endedLock(lock) {
  const finished = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const pid = Number(finished.stdout);
  writeFileSync(lock, `${JSON.stringify({ checkout: '/work/old', pid, processStart: 'Mon Oct  5 00:00:00 2026', acquired: '2026-10-05T00:00:00.000Z', command: 'old', token: 'ended' })}\n`);
  return pid;
}

const tool = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

test('the start time of a process is read from /proc/<pid>/stat and the boot time, after the closing parenthesis', () => {
  const stat = '1234 (a b) c) S 1 1234 1234 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 1000 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0';
  assert.equal(procStart(stat, 'cpu 1\nbtime 1700000000\n'), '987654 clock ticks after the boot at 2023-11-14T22:13:20.000Z');
  assert.throws(() => procStart('1234 (x) S 1', 'btime 1\n'), /holds no start time/);
  assert.throws(() => procStart(stat, 'cpu 1\n'), /holds no boot time/);
});

test('the start time of a running process is known and the start time of an ended process is null', () => {
  assert.match(processStart(process.pid), /\S/);
  assert.equal(processStart(process.pid), processStart(process.pid));
  const finished = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(processStart(Number(finished.stdout)), null);
});

test('a lock names its holder, a second holder is refused with it, and the holder releases it', { timeout: 20_000 }, async (t) => {
  const lock = path.join(workspace(t), 'nested/resource.lock');
  const { child, ended } = await holdLock(t, lock);
  const record = readLockRecord(lock);
  assert.equal(record.pid, child.pid);
  assert.equal(record.checkout, '/work/checkout');
  assert.equal(record.command, 'holder');
  assert.equal(record.processStart, processStart(child.pid));
  assert.match(record.token, /^[0-9a-f]{32}$/);
  assert.deepEqual(readdirSync(path.dirname(lock)), ['resource.lock'], 'a file of the write stayed beside the lock');

  assert.throws(() => acquireHolderLock(lock), (error) => {
    assert.equal(error.name, 'HolderLockRefused');
    assert.match(error.message, new RegExp(`resource\\.lock is held by process ${child.pid} \\(started .*\\) of the checkout /work/checkout, held since .* for "holder"; the holder releases it`));
    assert.equal(error.record.pid, child.pid);
    return true;
  });
  child.stdin.end();
  assert.deepEqual(await ended, { status: 0, signal: null });
  assert.equal(existsSync(lock), false, 'the lock stayed after the holder ended');
  acquireHolderLock(lock).release();
  assert.equal(existsSync(lock), false);
});

test('a lock of an ended holder is reported and stays until clear removes it', (t) => {
  const lock = path.join(workspace(t), 'resource.lock');
  const pid = endedLock(lock);
  assert.throws(() => acquireHolderLock(lock), new RegExp(`held by process ${pid} .*which has ended; remove the lock with \`node .*holder-lock\\.mjs clear ${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
  assert.equal(existsSync(lock), true);
  const cleared = tool('clear', lock);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, new RegExp(`lock: removed .*resource\\.lock of process ${pid} .*, which has ended`));
  assert.equal(existsSync(lock), false);
  assert.equal(tool('clear', lock).status, 1);
});

test('a reused process ID is not a running holder: the start time differs', (t) => {
  const lock = path.join(workspace(t), 'resource.lock');
  // The record names the process of this test, which runs, with a start time that is not its own.
  writeFileSync(lock, `${JSON.stringify({ checkout: '/work/old', pid: process.pid, processStart: 'another start', acquired: '2026-10-05T00:00:00.000Z', command: 'old', token: 'reused' })}\n`);
  assert.equal(holderRunning(readLockRecord(lock)), false);
  assert.throws(() => acquireHolderLock(lock), /which has ended/);
  assert.equal(removeDeadLock(lock).token, 'reused');
  assert.equal(existsSync(lock), false);
});

test('clear fails while the holder runs and leaves the lock', { timeout: 20_000 }, async (t) => {
  const lock = path.join(workspace(t), 'resource.lock');
  const { child } = await holdLock(t, lock);
  const refused = tool('clear', lock);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`held by process ${child.pid} .*the holder releases it`));
  assert.equal(existsSync(lock), true);
});

test('a file that holds no record is an error and never a free lock', (t) => {
  const lock = path.join(workspace(t), 'resource.lock');
  writeFileSync(lock, 'not json');
  assert.throws(() => acquireHolderLock(lock), /resource\.lock holds no lock record: "not json"/);
  writeFileSync(lock, JSON.stringify({ pid: 1 }));
  assert.throws(() => acquireHolderLock(lock), /has no checkout of type string/);
  assert.equal(existsSync(lock), true);
});

test('the release checks the token: a lock that another holder replaced is not removed', (t) => {
  const lock = path.join(workspace(t), 'resource.lock');
  const held = acquireHolderLock(lock);
  writeFileSync(lock, `${JSON.stringify({ ...held.record, token: 'other' })}\n`);
  assert.throws(() => held.release(), /was replaced while process \d+ held it; it now names process/);
  assert.equal(existsSync(lock), true);
  rmSync(lock);
  // A second release finds the handle already released and does nothing.
  held.release();
});

test('a process takes and releases locks many times and leaves no listener behind', (t) => {
  const directory = workspace(t);
  const before = [process.listenerCount('exit'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'), process.listenerCount('SIGHUP')];
  for (let n = 0; n < 5; n += 1) acquireHolderLock(path.join(directory, 'a.lock')).release();
  assert.deepEqual([process.listenerCount('exit'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'), process.listenerCount('SIGHUP')], before);
});

test('a relative lock path is refused', () => {
  assert.throws(() => acquireHolderLock('resource.lock'), /must be an absolute path/);
  assert.throws(() => removeDeadLock('resource.lock'), /must be an absolute path/);
});

test('a holder that receives SIGTERM releases the lock and ends with the status 143', { timeout: 20_000 }, async (t) => {
  const lock = path.join(workspace(t), 'resource.lock');
  const { child, ended } = await holdLock(t, lock);
  child.kill('SIGTERM');
  assert.deepEqual(await ended, { status: 143, signal: null });
  assert.equal(existsSync(lock), false);
});

test('run holds the lock while the command runs and exits with its status', (t) => {
  const directory = workspace(t);
  const lock = path.join(directory, 'resource.lock');
  const probe = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(directory, 'seen'))}, fs.readFileSync(${JSON.stringify(lock)}, 'utf8')); process.exit(3)`;
  const ran = tool('run', lock, '--', process.execPath, '-e', probe);
  assert.equal(ran.status, 3, ran.stderr);
  assert.match(ran.stderr, /lock: acquired .*resource\.lock \(process \d+\)\nlock: released .*resource\.lock\n/);
  const seen = JSON.parse(readFileSync(path.join(directory, 'seen'), 'utf8'));
  assert.equal(seen.checkout, path.resolve(HERE, '../..'));
  assert.match(seen.processStart, /\S/);
  assert.equal(seen.command, `${process.execPath} -e ${probe}`);
  assert.equal(existsSync(lock), false);
});

test('run exits with 128 + n for a command that a signal ended and with 127 for a command that does not start, and releases the lock', (t) => {
  const lock = path.join(workspace(t), 'resource.lock');
  const signalled = tool('run', lock, '--', process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')");
  assert.equal(signalled.status, 143, signalled.stderr);
  assert.equal(existsSync(lock), false);
  const missing = tool('run', lock, '--', path.join(path.dirname(lock), 'missing-command'));
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /lock: .*missing-command did not start: /);
  assert.equal(existsSync(lock), false);
});

test('run is refused while another holder has the lock and runs nothing', { timeout: 20_000 }, async (t) => {
  const directory = workspace(t);
  const lock = path.join(directory, 'resource.lock');
  const { child } = await holdLock(t, lock);
  const refused = tool('run', lock, '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'ran'))}, '')`);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`lock: .*resource\\.lock is held by process ${child.pid} `));
  assert.equal(existsSync(path.join(directory, 'ran')), false);
  assert.equal(tool('run', lock).status, 1);
  assert.match(tool('frobnicate', lock).stderr, /usage: node scripts\/kit\/holder-lock\.mjs run <lock> -- <command>/);
});

test('only one of several processes that take the lock at once holds it', { timeout: 30_000 }, async (t) => {
  const lock = path.join(workspace(t), 'resource.lock');
  const code = `const { acquireHolderLock } = await import(${JSON.stringify(TOOL)}); try { acquireHolderLock(${JSON.stringify(lock)}, { checkout: '/work/checkout', command: 'racer' }); process.stdout.write('won\\n'); await new Promise(resolve => setTimeout(resolve, 400)); } catch (error) { process.stdout.write(error.name + '\\n'); }`;
  const racers = Array.from({ length: 6 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.once('exit', () => resolve(output.trim()));
  }));
  const results = await Promise.all(racers);
  assert.equal(results.filter(result => result === 'won').length, 1, results.join(', '));
  assert.deepEqual(results.filter(result => result !== 'won'), Array(5).fill('HolderLockRefused'));
  assert.equal(existsSync(lock), false);
});
