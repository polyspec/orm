// Ending the interface checker ends what it started: an extractor and the processes of the extractor, whichever way the checker ends.
// The fixture stands in for a hung extractor: it starts a child of its own, and each holds a connection to this test until it ends,
// so the test reads the end of a process from the end of its connection.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { caseTest, PROCESS } from '../../testcase.mts';
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

type Holders = { server: Server; port: number; both: Promise<Socket[]>; pids: Set<number> };

/** Listens for the two connections of a hung extractor and its child. */
async function listen(): Promise<Holders> {
  const pids = new Set<number>();
  const sockets: Socket[] = [];
  let announce: (sockets: Socket[]) => void = () => {};
  const both = new Promise<Socket[]>(done => { announce = done; });
  const server = createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', chunk => {
      pids.add(Number(String(chunk).trim()));
      sockets.push(socket);
      if (sockets.length === 2) announce(sockets);
    });
  });
  await new Promise<void>(done => { server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { server, port: address.port, both, pids };
}

/** Resolves when every socket has closed, and rejects when the signal of the case aborts first. */
function closed(sockets: Socket[], signal: AbortSignal): Promise<unknown> {
  const ended = Promise.all(sockets.map(socket => new Promise(done => { socket.once('close', done); })));
  const deadline = new Promise((_, fail) => {
    signal.addEventListener('abort', () => { fail(new Error('a process that the checker started is still running at the deadline')); }, { once: true });
  });
  return Promise.race([ended, deadline]);
}

/** Ends the process if it is still running. */
function endProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
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
  caseTest(`${signalName} of the checker ends its hung extractor and the child of the extractor`, PROCESS, async ({ signal }) => {
    await withHolders(async (holders, directory) => {
      const checker = spawn(process.execPath, ['tests/interfaces/check/main.mts', '-language', 'python'], {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, ORM_PYTHON: hungExtractor(directory), ORM_HANG_PORT: String(holders.port) },
      });
      try {
        const sockets = await holders.both;
        checker.kill(signalName);
        await closed(sockets, signal);
      } finally {
        checker.kill('SIGKILL');
      }
    });
  });
}

caseTest('the abort of a run ends the program and the child of the program', PROCESS, async ({ signal }) => {
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
