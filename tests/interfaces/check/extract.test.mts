// Ending the interface checker ends what it started: an extractor and the processes of the extractor, whichever way the checker ends.
// The fixture stands in for a hung extractor: it starts a child of its own, and each holds a connection to this test until it ends,
// so the test reads the end of a process from the end of its connection.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isolatedEnvironment } from '../../environment.mts';
import { errorCode } from '../../errors.mts';
import { caseTest } from '../../testcase.mts';
import { run } from './extract.mts';

const root = resolve(import.meta.dirname, '../../..');

const HOLD = `const socket = require('node:net').connect(Number(process.env.ORM_HANG_PORT), '127.0.0.1');
socket.write(process.pid + '\\n');
socket.on('error', () => process.exit(1));
setInterval(() => {}, 1 << 30);`;

/** The hung extractor as an executable file: it holds its connection and starts a child that holds one. */
function hungExtractor(directory: string): string {
  const path = join(directory, 'hung-extractor.cjs');
  writeFileSync(path, `#!${process.execPath}
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(HOLD)}], { stdio: 'ignore' });
${HOLD}
`);
  chmodSync(path, 0o755);
  return path;
}

// The end of a connection is recorded from its accept, so an end that comes before a test asks for it is not lost.
type Holder = { pid: number; gone: Promise<unknown> };
type Holders = { server: Server; port: number; both: Promise<Holder[]>; pids: Set<number> };

/** Listens for the two connections of a hung extractor and its child. */
async function listen(): Promise<Holders> {
  const pids = new Set<number>();
  const held: Holder[] = [];
  let announce: (held: Holder[]) => void = () => {};
  const both = new Promise<Holder[]>(done => { announce = done; });
  const server = createServer(socket => {
    socket.on('error', () => {});
    const gone = new Promise(done => { socket.once('close', done); });
    socket.once('data', chunk => {
      const pid = Number(String(chunk).trim());
      pids.add(pid);
      held.push({ pid, gone });
      if (held.length === 2) announce(held);
    });
  });
  await new Promise<void>(done => { server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { server, port: address.port, both, pids };
}

/** Whether the process runs: signal 0 tests for it and sends nothing. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
    return false;
  }
}

/** Resolves when every connection has closed, and rejects when the run is stopped first (the signal of the case), naming the processes that still run. */
function closed(held: Holder[], signal: AbortSignal): Promise<unknown> {
  const ended = Promise.all(held.map(holder => holder.gone));
  const stopped = new Promise((_, fail) => {
    signal.addEventListener('abort', () => {
      const left = held.filter(holder => running(holder.pid)).map(holder => holder.pid);
      fail(new Error(`a process that the checker started is still running when the run was stopped: ${left.length === 0 ? 'none runs, so a connection did not report its end' : left.join(', ')}`));
    }, { once: true });
  });
  return Promise.race([ended, stopped]);
}

/** Ends the process if it is still running. */
function endProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
  }
}

/** Runs body with the listener and a directory, and ends whatever a failed case leaves running. */
async function withHolders(body: (holders: Holders, directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'orm-interface-extract-'));
  const holders = await listen();
  try {
    await body(holders, directory);
  } finally {
    for (const pid of holders.pids) endProcess(pid);
    holders.server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const signalName of ['SIGKILL', 'SIGTERM'] as const) {
  caseTest(`${signalName} of the checker ends its hung extractor and the child of the extractor`, async ({ signal }) => {
    await withHolders(async (holders, directory) => {
      const checker = spawn(process.execPath, ['tests/interfaces/check/main.mts', '-language', 'python'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: isolatedEnvironment({ ORM_PYTHON: hungExtractor(directory), ORM_HANG_PORT: String(holders.port) }),
      });
      let output = '';
      checker.stdout.on('data', chunk => { output += chunk; });
      checker.stderr.on('data', chunk => { output += chunk; });
      // A checker that ends before it starts the extractor fails the case with what it printed, so the case does not wait
      // for its deadline on an extractor that never starts.
      const early = new Promise<Error>(done => {
        checker.once('exit', (code, ended) => {
          done(new Error(`the checker ended (${code ?? ended}) before it started the extractor:\n${output}`));
        });
      });
      try {
        const held = await Promise.race([holders.both, early]);
        if (held instanceof Error) throw held;
        checker.kill(signalName);
        await closed(held, signal);
      } finally {
        checker.kill('SIGKILL');
      }
    });
  });
}

caseTest('the abort of a run ends the program and the child of the program', async ({ signal }) => {
  await withHolders(async (holders, directory) => {
    process.env['ORM_HANG_PORT'] = String(holders.port);
    const controller = new AbortController();
    const finished = run(hungExtractor(directory), [], { signal: controller.signal });
    const ended = closed(await holders.both, signal);
    controller.abort(new Error('the deadline of the case'));
    await assert.rejects(finished);
    await ended;
  });
});

// T390: an abort and the end of the checker are requests: the program gets SIGTERM and runs its cleanup.
const CLEANS_UP = (marker: string): string => `const { writeFileSync } = require('node:fs'); const server = require('node:net').createServer().listen();
  process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(marker)}, 'cleaned'); server.close(); }); console.log('ready');`;

caseTest('the abort of a run asks the program to end and the run waits for its cleanup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orm-interface-abort-'));
  try {
    const marker = join(directory, 'cleaned');
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const finished = run(process.execPath, ['-e', CLEANS_UP(marker)], { signal: controller.signal, onOutput: () => { ready.resolve(); } });
    await ready.promise;
    controller.abort(new Error('the case aborts the run'));
    await assert.rejects(finished, /the case aborts the run/);
    assert.equal(readFileSync(marker, 'utf8'), 'cleaned', 'the program ran its cleanup before the run rejected');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

caseTest('the reaper asks the groups of an ended checker to end', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orm-interface-reaper-'));
  try {
    const marker = join(directory, 'cleaned');
    const program = spawn(process.execPath, ['-e', CLEANS_UP(marker)], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: isolatedEnvironment() });
    await new Promise<void>(ready => program.stdout.once('data', () => ready()));
    const ended = new Promise<number | null>(done => program.once('close', code => done(code)));
    const reaper = spawn(process.execPath, [join(root, 'tests/interfaces/check/reaper.mts')], { stdio: ['pipe', 'ignore', 'pipe'], env: isolatedEnvironment() });
    let errors = '';
    reaper.stderr.on('data', chunk => { errors += String(chunk); });
    const reaped = new Promise<number | null>(done => reaper.once('close', code => done(code)));
    reaper.stdin.end(`+${program.pid}\n`);
    assert.equal(await ended, 0, 'the program ended by its own cleanup');
    assert.equal(readFileSync(marker, 'utf8'), 'cleaned');
    assert.equal(await reaped, 0, errors);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
