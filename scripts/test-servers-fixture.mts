import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
