import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths, type Paths } from './test-servers.mts';

/** Runs a synchronous stop-test callback with an isolated server root and restores process.kill on every path. */
export function withPidFixture<T>(run: (fixture: { root: string; paths: Paths }) => T): T {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orm-pid-fixture-')));
  const originalKill = Object.getOwnPropertyDescriptor(process, 'kill');
  if (originalKill === undefined) throw new Error('process.kill has no property descriptor');
  try {
    return run({ root, paths: paths(root, join(root, 'sockets')) });
  } finally {
    Object.defineProperty(process, 'kill', originalKill);
    rmSync(root, { recursive: true, force: true });
  }
}

/** The options of withFixtureServer. */
export type FixtureServerOptions = {
  // prefix names the two directories of the server: its root under the temporary directory, and its socket folder in /tmp,
  // since a Unix socket path cannot exceed 104 bytes.
  prefix: string;
  // pidFile is the file under the root where the server writes its pid.
  pidFile: string;
  // signal is the stop request of the case (caseTest gives it; SIGINT and SIGTERM abort it).
  signal: AbortSignal;
  // stop stops the process of pid and returns after it exited, or throws.
  stop: (pid: number) => void;
};

// withFixtureServer runs work, which starts a fixture server in root, and stops that server when the case ends: when work
// returns, throws, or the case is asked to stop while work waits (T612, HR-87). A server whose data directory is removed under
// it never exits, so the server is stopped by its pid file first and the directories are removed after it exited; a server
// that does not stop fails the case and keeps them. A server that wrote no pid file did not start.
export async function withFixtureServer<T>(options: FixtureServerOptions, work: (dirs: { root: string; sockets: string }) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), options.prefix));
  const sockets = mkdtempSync(join('/tmp', options.prefix));
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(options.signal.reason);
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work({ root, sockets })), aborted]);
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    aborted.catch(() => {});
    const pidFile = join(root, options.pidFile);
    if (existsSync(pidFile)) options.stop(Number(readFileSync(pidFile, 'utf8').trim()));
    rmSync(root, { recursive: true, force: true });
    rmSync(sockets, { recursive: true, force: true });
  }
}
