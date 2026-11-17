import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseTest } from '../tests/testcase.mts';
import { withFixtureServer, withPidFixture } from './test-servers-fixture.mts';

caseTest('removes its temporary root and restores process.kill after success and failure', () => {
  const originalKill = Object.getOwnPropertyDescriptor(process, 'kill');
  assert.ok(originalKill);
  let successRoot = '';
  const result = withPidFixture(({ root, paths }) => {
    successRoot = root;
    assert.equal(paths.root, root);
    assert.ok(existsSync(root));
    process.kill = () => true;
    return paths.dir;
  });
  assert.equal(result.startsWith(successRoot), true);
  assert.equal(existsSync(successRoot), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'kill'), originalKill);

  const expected = new Error('fixture callback failed');
  let failureRoot = '';
  assert.throws(() => withPidFixture(({ root }) => {
    failureRoot = root;
    process.kill = () => { throw new Error('stubbed kill'); };
    throw expected;
  }), error => error === expected);
  assert.equal(existsSync(failureRoot), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'kill'), originalKill);
});

// withFixtureServer (T612, HR-87): a case that starts a fixture server stops it, by the pid file that the server wrote, before
// it removes the directories of the server, when the case passes, fails or is asked to stop. A fake pid file stands for the
// server, so no server starts.
function recorder() {
  const stops: { pid: number; root: boolean; sockets: boolean }[] = [];
  const dirs: { root: string; sockets: string }[] = [];
  return { stops, dirs, stop: (pid: number) => { const last = dirs.at(-1); stops.push({ pid, root: existsSync(last?.root ?? ''), sockets: existsSync(last?.sockets ?? '') }); } };
}

caseTest('a fixture server stops before its directories are removed when the case passes or fails', async () => {
  for (const failure of [undefined, new Error('the case failed')]) {
    const seen = recorder();
    const work = withFixtureServer({ prefix: 'orm-fixture-test-', pidFile: 'server.pid', signal: new AbortController().signal, stop: seen.stop }, ({ root, sockets }) => {
      seen.dirs.push({ root, sockets });
      writeFileSync(join(root, 'server.pid'), '4242\n');
      if (failure) throw failure;
      return 'done';
    });
    if (failure) await assert.rejects(work, error => error === failure);
    else assert.equal(await work, 'done');
    assert.deepEqual(seen.stops, [{ pid: 4242, root: true, sockets: true }]);
    const [dirs] = seen.dirs;
    assert.ok(dirs);
    assert.equal(existsSync(dirs.root) || existsSync(dirs.sockets), false);
  }
});

caseTest('a fixture server stops when the case is asked to stop while it waits', async () => {
  const seen = recorder();
  const controller = new AbortController();
  const work = withFixtureServer({ prefix: 'orm-fixture-test-', pidFile: 'server.pid', signal: controller.signal, stop: seen.stop }, ({ root, sockets }) => {
    seen.dirs.push({ root, sockets });
    writeFileSync(join(root, 'server.pid'), '4343\n');
    controller.abort(new Error('the process was asked to stop by SIGTERM'));
    // The work waits for an event that never comes; only the stop request ends the case.
    return new Promise<never>(() => {});
  });
  await assert.rejects(work, /asked to stop by SIGTERM/);
  assert.deepEqual(seen.stops, [{ pid: 4343, root: true, sockets: true }]);
  const [dirs] = seen.dirs;
  assert.ok(dirs);
  assert.equal(existsSync(dirs.root) || existsSync(dirs.sockets), false);
});

caseTest('a fixture server that does not stop keeps its directories', async () => {
  const dirs: string[] = [];
  const refused = new Error('the server did not stop');
  await assert.rejects(withFixtureServer({ prefix: 'orm-fixture-test-', pidFile: 'server.pid', signal: new AbortController().signal, stop: () => { throw refused; } }, ({ root, sockets }) => {
    dirs.push(root, sockets);
    writeFileSync(join(root, 'server.pid'), '4444\n');
  }), error => error === refused);
  assert.deepEqual(dirs.map(existsSync), [true, true]);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

caseTest('a fixture server that wrote no pid file is not stopped', async () => {
  const seen = recorder();
  await withFixtureServer({ prefix: 'orm-fixture-test-', pidFile: 'server.pid', signal: new AbortController().signal, stop: seen.stop }, ({ root, sockets }) => { seen.dirs.push({ root, sockets }); });
  assert.deepEqual(seen.stops, []);
});
