// The check runner and one step of owner-check (command of scripts/check/run.mts) run in their own temporary directory (TMPDIR) and their own
// process group. If a step that passed leaves a temporary entry or process, that step fails; the temporary entries left by a failed step
// are copied to the report. Either way, nothing is left after the step. Each case runs the step with a real sh.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { errorCode } from '../../tests/errors.mts';
import { command } from './run.mts';
import { endGroup, groupProcesses, runStep, signalGroup, stopGroup, processGroupOf } from './step.mts';
import { spawn } from 'node:child_process';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const run = command(repo);

// step collects the output lines of the step.
function collect() {
  const lines: string[] = [];
  return { lines, step: (line: string) => { lines.push(line); } };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
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
    assert.ok(made, lines.join(' | '));
    assert.equal(existsSync(join(made, 'orm-leftover-probe')), false);
  } finally {
    rmSync(leftover, { recursive: true, force: true });
  }
});

// The forked child is named after the shell until it runs exec; the step waits for the exec of sleep.
const UNTIL_EXEC = 'until ps -o args= -p $! | grep -q "^sleep "; do :; done';

// removeCase kills the process of a case that is still alive, and removes the temporary directory of the case.
function removeCase(work: string, pid: number): void {
  if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(work, { recursive: true, force: true });
}

caseTest('a passed step that leaves a process in its group fails and the process is killed', PROCESS, async () => {
  const work = mkdtempSync(join(tmpdir(), 'orm-step-test-'));
  const pidFile = join(work, 'pid');
  let pid = 0;
  try {
    const { lines, step } = collect();
    const error = await run('sh', ['-c', `sleep 37 >/dev/null 2>&1 & echo $! > ${pidFile}; ${UNTIL_EXEC}`], step).then(() => null, (error: unknown) => error);
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(error instanceof Error, 'the step fails');
    assert.match(error.message, new RegExp(`left 1 processes: ${pid} sleep 37`));
    assert.ok(lines.some(line => line.includes(`left 1 processes: ${pid} sleep 37`)), lines.join(' | '));
    assert.equal(alive(pid), false, `process ${pid} is killed`);
  } finally {
    removeCase(work, pid);
  }
});

caseTest('a failed step keeps its temporary entries in the report and leaves no process', PROCESS, async () => {
  const work = mkdtempSync(join(tmpdir(), 'orm-step-test-'));
  const keep = join(work, 'kept');
  const pidFile = join(work, 'pid');
  let pid = 0;
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
    removeCase(work, pid);
  }
});

caseTest("npm's compile cache stays in the system temporary directory and is not a leftover of the step", PROCESS, async () => {
  const { lines, step } = collect();
  await run('sh', ['-c', 'echo "cache=$NODE_COMPILE_CACHE"; npm --version'], step);
  // Run inside the runner, it uses as-is the cache the outer step already set.
  const expected = process.env.NODE_COMPILE_CACHE ?? join(tmpdir(), 'node-compile-cache');
  assert.ok(lines.includes(`cache=${expected}`), lines.join(' | '));
});

caseTest('endGroup names and ends what a process of its own group left behind', PROCESS, async () => {
  const child = spawn('sh', ['-c', 'sleep 39 >/dev/null 2>&1 & echo $!'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: isolatedEnvironment() });
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

caseTest('signalGroup treats only ESRCH as absent and preserves other native kill errors', COMPUTE, () => {
  const originalKill = process.kill.bind(process);
  const own = processGroupOf(process.pid);
  const group = Math.max(process.pid + 1000, (own ?? 0) + 1000);
  try {
    for (const code of ['ESRCH', 'EPERM', 'EINVAL']) {
      const failure = Object.assign(new Error(`kill ${code}`), { code });
      process.kill = () => { throw failure; };
      if (code === 'ESRCH') assert.equal(signalGroup(group, 'SIGTERM'), false);
      else assert.throws(() => signalGroup(group, 'SIGTERM'), error => error === failure);
    }
  } finally {
    process.kill = originalKill;
  }
});

// T462: a stop is a request. A SIGTERM that cannot be sent is the failure of the cleanup, and no SIGKILL follows it.
caseTest('a SIGTERM that cannot be sent fails the cleanup and no SIGKILL follows', PROCESS, async () => {
  const child = spawn(process.execPath, ['-e', 'require("node:net").createServer().listen()'], { detached: true, stdio: 'ignore', env: isolatedEnvironment() });
  const originalKill = process.kill.bind(process);
  const term = Object.assign(new Error('TERM denied'), { code: 'EPERM' });
  const sent: (NodeJS.Signals | number | undefined)[] = [];
  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    process.kill = (_pid: number, signal?: NodeJS.Signals | number) => {
      sent.push(signal);
      throw term;
    };
    await assert.rejects(endGroup(child.pid), error => error === term);
    assert.deepEqual(sent, ['SIGTERM']);
  } finally {
    process.kill = originalKill;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      originalKill(-child.pid, 'SIGKILL');
      await new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
    }
  }
});

// T462: stopGroup sends SIGTERM, says what it waits for, waits for the event that the owner of the group has for its end,
// and sends nothing else. The member ends after its cleanup and after the case has seen the line, so the line always
// names it: the case closes the input of the member when the line comes, and the member ends when it has both.
caseTest('stopGroup asks a group to end, names what it waits for and waits for the event of its owner', PROCESS, async () => {
  const work = mkdtempSync(join(tmpdir(), 'orm-step-stop-'));
  const marker = join(work, 'cleaned');
  const script = `const { writeFileSync } = require('node:fs'); const server = require('node:net').createServer().listen();
    let asked = false; let released = false; const end = () => { if (asked && released) server.close(); };
    process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(marker)}, 'cleaned'); asked = true; end(); });
    process.stdin.on('end', () => { released = true; end(); }); process.stdin.resume(); console.log('ready');`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['pipe', 'pipe', 'ignore'], env: isolatedEnvironment() });
  const originalKill = process.kill.bind(process);
  const sent: (NodeJS.Signals | number | undefined)[] = [];
  try {
    await new Promise<void>(ready => child.stdout.once('data', () => ready()));
    const closed = new Promise<void>(close => child.once('close', () => close()));
    process.kill = (pid: number, signal?: NodeJS.Signals | number) => {
      sent.push(signal);
      return originalKill(pid, signal);
    };
    const reported: string[] = [];
    assert.ok(child.pid);
    const alive = await stopGroup(child.pid, closed, line => {
      reported.push(line);
      child.stdin.end();
    });
    assert.deepEqual(alive, [], 'no member outlives the event');
    assert.deepEqual(sent, ['SIGTERM']);
    assert.equal(reported.length, 1, reported.join(' | '));
    assert.match(reported[0] ?? '', new RegExp(`sent SIGTERM to process group ${child.pid} and waits for its end with no time limit: ${child.pid} `));
    assert.equal(readFileSync(marker, 'utf8'), 'cleaned', 'the member ran its cleanup before the wait ended');
    assert.equal(child.exitCode, 0);
  } finally {
    process.kill = originalKill;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(work, { recursive: true, force: true });
  }
});

// T462: a member that ignores SIGTERM is named, alive, in the result when the event of its owner has come. It is not killed.
caseTest('stopGroup names a member that ignores SIGTERM and does not kill it', PROCESS, async () => {
  const script = "require('node:net').createServer().listen(); process.on('SIGTERM', () => {}); console.log('ready');";
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: isolatedEnvironment() });
  const originalKill = process.kill.bind(process);
  const sent: (NodeJS.Signals | number | undefined)[] = [];
  try {
    await new Promise<void>(ready => child.stdout.once('data', () => ready()));
    assert.ok(child.pid);
    process.kill = (pid: number, signal?: NodeJS.Signals | number) => {
      sent.push(signal);
      return originalKill(pid, signal);
    };
    const survivors = await stopGroup(child.pid, Promise.resolve(), () => {});
    assert.equal(survivors.length, 1, survivors.join(' | '));
    assert.ok(survivors[0]?.startsWith(`${child.pid} `), survivors.join(' | '));
    assert.deepEqual(sent, ['SIGTERM']);
    assert.equal(alive(child.pid), true, 'the member is not killed');
  } finally {
    process.kill = originalKill;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      originalKill(-child.pid, 'SIGKILL');
      await new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
    }
  }
});

// T462: an interrupted runner admits no step, asks the group of its step to end and exits after the step has ended and
// has been checked, with the status of its signal.
caseTest('an interrupted runner waits for the cleanup of its step before it exits', PROCESS, async () => {
  const root = mkdtempSync(join(tmpdir(), 'orm-step-interrupt-'));
  const marker = join(root, 'cleaned');
  const modulePath = new URL('./step.mts', import.meta.url).pathname;
  const stepScript = `const { writeFileSync } = require('node:fs'); const server = require('node:net').createServer().listen();
    process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(marker)}, 'cleaned'); server.close(); }); console.log('ready');`;
  const runner = spawn(process.execPath, ['--input-type=module', '-e', `
    import { runStep } from ${JSON.stringify(modulePath)};
    const options = { cwd: ${JSON.stringify(root)}, env: { PATH: process.env.PATH }, step: line => console.log(line), label: 'fake' };
    const first = runStep(process.execPath, ['-e', ${JSON.stringify(stepScript)}], options).then(() => 'passed', error => 'failed: ' + error.message);
    process.on('SIGTERM', () => { runStep('true', [], options).then(() => console.log('second: admitted'), error => console.log('second: ' + error.message)); });
    console.log('first: ' + await first);
  `], { stdio: ['ignore', 'pipe', 'pipe'], env: isolatedEnvironment() });
  try {
    let out = '';
    let err = '';
    runner.stderr.on('data', chunk => { err += String(chunk); });
    await new Promise<void>(ready => runner.stdout.on('data', chunk => {
      out += String(chunk);
      if (out.includes('ready')) ready();
    }));
    assert.ok(runner.pid);
    process.kill(runner.pid, 'SIGTERM');
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => runner.once('close', (code, signal) => resolveExit({ code, signal })));
    assert.deepEqual(result, { code: 143, signal: null }, `${out}\n${err}`);
    assert.equal(readFileSync(marker, 'utf8'), 'cleaned', 'the step ran its cleanup');
    assert.match(out, /second: check: the runner was interrupted and admits no step/);
    assert.match(err, /check: SIGTERM: no step is admitted; sent SIGTERM to the process groups? of 1 steps? and waits for them with no time limit/);
  } finally {
    if (runner.pid && runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

caseTest('failed group cleanup stays tracked and makes an otherwise successful runner exit nonzero', PROCESS, async () => {
  const root = mkdtempSync(join(tmpdir(), 'orm-step-cleanup-status-'));
  const pidFile = join(root, 'pid');
  const modulePath = new URL('./step.mts', import.meta.url).pathname;
  let child: ReturnType<typeof spawn> | undefined;
  const originalKill = process.kill.bind(process);
  try {
    const runner = spawn(process.execPath, ['--input-type=module', '-e', `
      import { runStep } from ${JSON.stringify(modulePath)};
      const originalKill = process.kill;
      process.kill = ((target, signal) => { if (target < 0) throw Object.assign(new Error('cleanup denied'), { code: 'EPERM' }); return originalKill(target, signal); });
      try { await runStep('sh', ['-c', 'sleep 900 >/dev/null 2>&1 & echo $! > ${pidFile}; exit 0'], { cwd: ${JSON.stringify(root)}, env: { PATH: process.env.PATH }, step: () => {}, label: 'fake' }); } catch {}
    `], { stdio: ['ignore', 'ignore', 'pipe'], env: isolatedEnvironment() });
    child = runner;
    let stderr = '';
    assert.ok(runner.stderr);
    runner.stderr.on('data', chunk => { stderr += String(chunk); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => runner.once('close', (code, signal) => resolveExit({ code, signal })));
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, 1, `cleanup failure left successful exit status: ${stderr}`);
    assert.match(stderr, /could not send SIGTERM to process group/);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    originalKill(pid, 'SIGKILL');
  } finally {
    if (child?.pid && alive(child.pid)) originalKill(child.pid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

// The fake runner case (G5.77) starts the runner's node process in its own group, and inside it sends the step's group signal
// to it. Signals sent to its own group, to group 0 and 1, or to negative groups are rejected, so the runner survives, and a signal sent to that group as is
// ends the runner (control). runStep, which ends processes the step left behind, does not end the runner either.
caseTest('a group signal never reaches the process group of the runner', PROCESS, async () => {
  const stepModule = new URL('./step.mts', import.meta.url).pathname;
  const fake = (body: string) => new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { signalGroup, processGroupOf, runStep } from ${JSON.stringify(stepModule)};
      const own = processGroupOf(process.pid);
      ${body}
      console.log('alive');
    `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: isolatedEnvironment() });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { out += String(chunk); });
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

// The step-name case (G5.77) checks that the runner finds, as a leftover of the step, the directory that a step's process created in .runtime/run
// with the step name (ORM_STEP) and deletes it. The test-binary copy of tests/cargo-test.mts is in that directory (on CI /tmp is a tmpfs that uses
// memory, so the copy is kept on disk).
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
  const { topProcesses, resourceLines } = await import('./resources.mts');
  assert.deepEqual(topProcesses(' 10  10  2048 mysqld\n 11  10 1024000 postgres\n 12 12 512 sh\n', 2), [
    { pid: 11, pgid: 10, rssMiB: 1000, command: 'postgres' }, { pid: 10, pgid: 10, rssMiB: 2, command: 'mysqld' }]);
  const lines = resourceLines(new Date(0));
  assert.equal(lines.length, 4);
  assert.match(lines[0] ?? '', /^RESOURCES 1970-01-01T00:00:00\.000Z memory /);
  assert.match(lines[3] ?? '', /^RESOURCES group signals /);
});

// T351: the process table is listed with a bounded output, so a large table never fails a step. An overflow names ENOBUFS, and a group
// member with a command line longer than the buffer that the listing uses by default is still listed with its command.
caseTest('the group listing names ENOBUFS when the process table overflows, and lists a long command of its group', PROCESS, async () => {
  // Linux refuses one argument longer than 128 KiB (MAX_ARG_STRLEN) with E2BIG, so the long command line is four arguments.
  const padding = Array.from({ length: 4 }, () => 'x'.repeat(100_000));
  const child = spawn('sh', ['-c', 'sleep 30', 'sh', ...padding], { detached: true, stdio: 'ignore' });
  try {
    const pid = child.pid;
    assert.ok(pid !== undefined, 'the group leader has a process id');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.throws(() => groupProcesses(pid, { maxBuffer: 64 }), /ENOBUFS/);
    const found = groupProcesses(pid);
    assert.ok(found.some(process => process.pid === pid && process.command.includes('sleep 30')), 'the group member is listed with its command');
  } finally {
    child.kill('SIGKILL');
  }
});
