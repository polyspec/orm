// The lock of a bench database (main.mts lockDatabases): the lock of a run that ended without releasing it does not hold,
// and the lock of a running holder refuses naming its pid.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { isolatedEnvironment } from '../../environment.mts';
import { PROCESS, caseTest } from '../../testcase.mts';
import { lockDatabases, releaseLocks } from './main.mts';

// helper is the program of another process that takes the lock of ORM_LOCK_HELPER. With ORM_LOCK_HOLD it holds the lock
// until its standard input closes; without it, it is killed at once without releasing the lock, like a killed run.
const helper = `import { lockDatabases } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'main.mts')).href)};
try { lockDatabases(process.env.ORM_LOCK_HELPER ?? ''); } catch (error) { console.log('refused: ' + error.message); process.exit(3); }
console.log('locked');
if (process.env.ORM_LOCK_HOLD) { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); } else process.kill(process.pid, 'SIGKILL');
`;

caseTest('TestLockOfAnEndedRunDoesNotHold', PROCESS, async () => {
  const previous = process.env.TMPDIR;
  const directory = mkdtempSync(join(tmpdir(), 'orm-lock-test-'));
  process.env.TMPDIR = directory;
  try {
    const dsn = 'mysql://root@127.0.0.1:1/orm_lock_test_TestLockOfAnEndedRunDoesNotHold';
    const env = isolatedEnvironment({ TMPDIR: directory, ORM_LOCK_HELPER: dsn });
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', helper], { env, encoding: 'utf8' });
    assert.match(killed.stdout, /locked/, `the first run did not lock: ${killed.stdout}${killed.stderr}`);
    assert.equal(killed.signal, 'SIGKILL', 'the first run was not killed while it held the lock');
    lockDatabases(dsn);
    releaseLocks();

    const holder = spawn(process.execPath, ['--input-type=module', '-e', helper], { env: { ...env, ORM_LOCK_HOLD: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = new Promise(done => holder.on('close', done));
    let line = '';
    for await (line of createInterface({ input: holder.stdout })) if (line === 'locked' || line.startsWith('refused')) break;
    assert.equal(line, 'locked', 'the holder did not lock');
    let refusal: unknown = null;
    try {
      lockDatabases(dsn);
    } catch (error) {
      refusal = error;
    }
    holder.stdin.end();
    await exited;
    assert.ok(refusal instanceof Error && refusal.message.includes('another conformance run'), `a running holder's lock did not hold: ${String(refusal)}`);
    assert.ok(refusal.message.includes(`pid ${holder.pid}`), `the refusal ${refusal.message} does not name the holder (pid ${holder.pid})`);
  } finally {
    releaseLocks();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});
