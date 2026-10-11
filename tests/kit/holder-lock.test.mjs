// Tests of the holder lock (scripts/kit/holder-lock.mjs): one holder at a time, a refusal that names the holder, release by
// the holder only, a holder identified by its start time, and a lock of an ended holder that is reported and removed only
// by `clear`. Every test uses a directory of its own and real processes; the start time on Linux and Windows is tested with
// a host of that platform (fakeHost), and the races of `clear` through the points that removeDeadLock offers between steps.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const STAT = '1234 (a b) c) S 1 1234 1234 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 1000 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0';
const BOOT_ID = '6f1c2a54-08a9-4f3e-9a63-2c1e5b7d9f10';

// A host of another platform for processStart: `files` are the texts that readFile returns (an Error is thrown), `kills` the
// codes that the kill(pid, 0) calls throw in turn (undefined: the process exists), `commands` the outcome of each command.
// `calls` records every call.
function fakeHost(platform, { files = {}, kills = [], commands = {} } = {}) {
  const calls = [];
  const pending = [...kills];
  const fail = (message, code) => Object.assign(new Error(message), { code });
  return {
    calls,
    platform,
    kill(pid) {
      calls.push(['kill', pid]);
      const code = pending.shift();
      if (code) throw fail(`kill ${pid}: ${code}`, code);
    },
    readFile(file) {
      calls.push(['readFile', file]);
      const value = files[file];
      if (value instanceof Error) throw value;
      if (value === undefined) throw fail(`${file}: ENOENT`, 'ENOENT');
      return value;
    },
    execute(command, args, options) {
      calls.push(['execute', command, ...args, options?.env?.LC_ALL]);
      if (!(command in commands)) throw new Error(`${command} was run`);
      return commands[command];
    },
  };
}

test('the start time of a process is read from /proc/<pid>/stat and the boot ID, after the closing parenthesis', () => {
  assert.equal(procStart(STAT, `${BOOT_ID}\n`), `987654 clock ticks after the boot ${BOOT_ID}`);
  assert.throws(() => procStart('1234 (x) S 1', BOOT_ID), /holds no start time/);
  assert.throws(() => procStart(STAT, '\n'), /boot_id holds no boot ID/);
});

test('on Linux the start time is the boot ID with the start ticks and does not move with the wall clock', () => {
  const files = { '/proc/42/stat': STAT, '/proc/sys/kernel/random/boot_id': `${BOOT_ID}\n`, '/proc/stat': 'cpu 1\nbtime 1700000000\n' };
  const host = fakeHost('linux', { files });
  const before = processStart(42, host);
  assert.equal(before, `987654 clock ticks after the boot ${BOOT_ID}`);
  // A step of the wall clock moves btime; the start time of the running holder stays.
  files['/proc/stat'] = 'cpu 1\nbtime 1700000003\n';
  assert.equal(processStart(42, host), before);
  assert.equal(holderRunning({ pid: 42, processStart: before }, host), true);
  assert.equal(host.calls.some(([, file]) => file === '/proc/stat'), false, 'the start time read /proc/stat');
});

test('on Linux an unreadable /proc/<pid>/stat (hidepid) asks kill(pid, 0) again: ESRCH is ended, otherwise the holder runs', () => {
  const hidden = Object.assign(new Error('/proc/42/stat: EACCES'), { code: 'EACCES' });
  const files = { '/proc/42/stat': hidden, '/proc/sys/kernel/random/boot_id': BOOT_ID };
  const record = { pid: 42, processStart: `1 clock ticks after the boot ${BOOT_ID}` };
  assert.equal(processStart(42, fakeHost('linux', { files, kills: ['EPERM', 'ESRCH'] })), null);
  assert.equal(processStart(42, fakeHost('linux', { kills: [undefined, 'ESRCH'] })), null, 'a process that ended before the read');
  assert.equal(holderRunning(record, fakeHost('linux', { files, kills: ['EPERM', 'EPERM'] })), true);
  assert.equal(holderRunning(record, fakeHost('linux', { files, kills: [undefined, undefined] })), true);
  const asked = fakeHost('linux', { files, kills: ['EPERM', 'EPERM'] });
  processStart(42, asked);
  assert.deepEqual(asked.calls, [['kill', 42], ['readFile', '/proc/42/stat'], ['kill', 42]]);
});

test('on Windows the start time is the creation time from PowerShell and ps is never run', () => {
  const host = fakeHost('win32', { commands: { 'powershell.exe': { status: 0, stdout: '134044416000000000\r\n', stderr: '' } } });
  assert.equal(processStart(42, host), '134044416000000000 (the Windows FILETIME of the creation)');
  const [, [, command, ...args]] = host.calls;
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(args[3], /Get-Process -Id 42 .*\.StartTime.*\.ToFileTimeUtc\(\)/);
  assert.equal(processStart(42, fakeHost('win32', { commands: { 'powershell.exe': { status: 3, stdout: '', stderr: '' } } })), null, 'a process that ended before the query');
  const denied = fakeHost('win32', { commands: { 'powershell.exe': { status: 4, stdout: '', stderr: '' } } });
  assert.equal(holderRunning({ pid: 42, processStart: 'x' }, denied), true, 'a creation time that cannot be read is a running holder');
  assert.equal(processStart(42, fakeHost('win32', { kills: ['ESRCH'] })), null);
  const missing = { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync powershell.exe ENOENT'), { code: 'ENOENT' }) };
  assert.throws(() => processStart(42, fakeHost('win32', { commands: { 'powershell.exe': missing } })), /powershell\.exe could not start: spawnSync powershell\.exe ENOENT/);
  assert.throws(() => processStart(42, fakeHost('win32', { commands: { 'powershell.exe': { status: 1, stdout: '', stderr: 'boom' } } })), /powershell\.exe exited with 1: boom/);
  assert.throws(() => processStart(42, fakeHost('win32', { commands: { 'powershell.exe': { status: 0, stdout: 'no time\r\n', stderr: '' } } })), /printed no creation time: "no time/);
});

test('on macOS the start time is the lstart of ps in the C locale', () => {
  const host = fakeHost('darwin', { commands: { ps: { status: 0, stdout: 'Mon Oct  5 00:00:00 2026\n', stderr: '' } } });
  assert.equal(processStart(42, host), 'Mon Oct  5 00:00:00 2026');
  assert.deepEqual(host.calls, [['kill', 42], ['execute', 'ps', '-o', 'lstart=', '-p', '42', 'C']]);
  assert.equal(processStart(42, fakeHost('darwin', { commands: { ps: { status: 1, stdout: '', stderr: '' } } })), null);
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

test('two clears at once leave one holder: the later clear refuses the lock that a new holder took', (t) => {
  const directory = workspace(t);
  const lock = path.join(directory, 'resource.lock');
  endedLock(lock);
  const holders = [];
  onEnd(t, () => {
    for (const holder of holders) {
      try {
        holder.release();
      } catch {
        // The lock of a holder that the race displaced names another holder.
      }
    }
  });
  let refused;
  assert.throws(() => removeDeadLock(lock, {
    // The other clear removes the ended holder's lock and a holder X takes it after this clear checked the record.
    afterCheck: () => {
      removeDeadLock(lock);
      holders.push(acquireHolderLock(lock, { command: 'X' }));
    },
    // A holder Y takes the lock while this clear claims it.
    afterClaim: () => {
      try {
        holders.push(acquireHolderLock(lock, { command: 'Y' }));
      } catch (error) {
        refused = error;
      }
    },
  }), (error) => {
    assert.equal(error.name, 'HolderLockRefused');
    assert.match(error.message, /for "X"; the holder releases it/);
    return true;
  });
  assert.deepEqual(holders.map(holder => holder.record.command), ['X'], 'two holders hold the lock');
  assert.match(refused?.message ?? '', /for "X"; the holder releases it/);
  assert.equal(readLockRecord(lock).token, holders[0].record.token);
  assert.deepEqual(readdirSync(directory), ['resource.lock'], 'a claim stayed beside the lock');
});

test('clear claims the lock by a hard link named by the hash of the record and refuses an existing claim', (t) => {
  const directory = workspace(t);
  const lock = path.join(directory, 'resource.lock');
  endedLock(lock);
  const claim = `${lock}.${createHash('sha256').update(readFileSync(lock)).digest('hex').slice(0, 32)}.clearing`;
  let seen;
  removeDeadLock(lock, { afterClaim: () => { seen = readdirSync(directory).sort(); } });
  assert.deepEqual(seen, [path.basename(lock), path.basename(claim)]);
  assert.deepEqual(readdirSync(directory), []);

  endedLock(lock);
  const interrupted = `${lock}.${createHash('sha256').update(readFileSync(lock)).digest('hex').slice(0, 32)}.clearing`;
  writeFileSync(interrupted, '');
  assert.throws(() => removeDeadLock(lock), new RegExp(`${path.basename(interrupted).replace(/\./g, '\\.')} exists: another clear of this holder is running or was interrupted`));
  assert.equal(existsSync(lock), true);
  assert.equal(existsSync(interrupted), true);
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

// Starts `count` racers that take the lock at once and returns the result of each: 'won' for the one that holds the lock,
// the error name for the others. A winner holds the lock until its standard input closes, and the parent closes it only
// after every racer has reported, so no racer starts after the hold has ended.
function race(lock, count) {
  const code = `const { acquireHolderLock } = await import(${JSON.stringify(TOOL)}); try { acquireHolderLock(${JSON.stringify(lock)}, { checkout: '/work/checkout', command: 'racer' }); process.stdout.write('won\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); } catch (error) { process.stdout.write(error.name + '\\n'); }`;
  const racers = Array.from({ length: count }, () => spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit'] }));
  const reports = racers.map(child => new Promise((resolve) => {
    let output = '';
    // A racer reports one line and then waits, so the report resolves on the line, not on the close of the racer.
    child.stdout.on('data', (data) => { output += data; if (output.endsWith('\n')) resolve(output.trim()); });
  }));
  const exits = racers.map(child => new Promise(resolve => child.once('close', resolve)));
  return { racers, reports, exits };
}

test('only one of several processes that take the lock at once holds it', { timeout: 30_000 }, async (t) => {
  const lock = path.join(workspace(t), 'resource.lock');
  const { racers, reports, exits } = race(lock, 6);
  // The winner is the racer whose report is 'won'; its input closes once all six reports are in, which is the event that ends its hold.
  const results = await Promise.all(reports);
  for (const [index, result] of results.entries()) if (result === 'won') racers[index].stdin.end();
  await Promise.all(exits);
  assert.equal(results.filter(result => result === 'won').length, 1, results.join(', '));
  assert.deepEqual(results.filter(result => result !== 'won'), Array(5).fill('HolderLockRefused'));
  assert.equal(existsSync(lock), false);
});

test('a clear that checked an ended holder cannot remove the lock that a new holder took after the check', (t) => {
  const directory = workspace(t);
  const lock = path.join(directory, 'resource.lock');
  endedLock(lock);
  let holder;
  onEnd(t, () => holder?.release());
  assert.throws(() => removeDeadLock(lock, {
    // The other clear removes the ended holder's record, and a holder X takes the lock after this clear checked the record.
    afterCheck: () => {
      removeDeadLock(lock);
      holder = acquireHolderLock(lock, { command: 'X' });
    },
  }), (error) => {
    assert.equal(error.name, 'HolderLockRefused');
    assert.match(error.message, /for "X"; the holder releases it/);
    return true;
  });
  assert.equal(readLockRecord(lock).token, holder.record.token, 'the live holder keeps its lock');
  assert.deepEqual(readdirSync(directory), ['resource.lock'], 'no claim stays beside the lock');
});

test('a clear that holds the claim of an ended holder refuses a second clear and a new holder, and removes the lock once', (t) => {
  const directory = workspace(t);
  const lock = path.join(directory, 'resource.lock');
  endedLock(lock);
  let refusedHolder;
  let refusedClear;
  const removed = removeDeadLock(lock, {
    afterClaim: () => {
      try {
        acquireHolderLock(lock, { command: 'X' });
      } catch (error) {
        refusedHolder = error;
      }
      try {
        removeDeadLock(lock);
      } catch (error) {
        refusedClear = error;
      }
    },
  });
  assert.equal(removed.command, 'old');
  assert.equal(refusedHolder?.name, 'HolderLockRefused');
  assert.match(refusedClear?.message ?? '', /exists: another clear of this holder is running or was interrupted/);
  assert.deepEqual(readdirSync(directory), [], 'the lock and its claim are removed, and the pending file of the refused holder is too');
});
