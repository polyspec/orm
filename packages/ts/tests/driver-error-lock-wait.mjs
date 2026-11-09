// The driver errors that driverError classifies. Each case builds the error of the driver and needs no database.
//
// Usage: npm run typescript:build && node --test packages/ts/tests/driver-error-lock-wait.mjs
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driverError, openDriver, parseDsn } from '../dist/driver.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

// Requirements: PLN-24.
caseTest('driver-error/sqlite-locked/sqlite', COMPUTE, () => {
  const source = Object.assign(new Error('database table is locked'), { code: 'SQLITE_LOCKED', errcode: 6 });
  const mapped = driverError('sqlite', source);
  assert.equal(mapped.code, 'DRIVER');
  assert.notEqual(mapped.code, 'DEADLOCK');
  assert.match(mapped.message, /sqlite: database table is locked/);
});

// Requirements: DIA-201. A mysql error number is read by the table of its server: MySQL's 4025 is an InnoDB option error and
// MariaDB's a failed CHECK, and MySQL's 3572, 3819, 3024 and 4031 name no MariaDB condition.
caseTest('driver-error/number-by-server/mysql', COMPUTE, () => {
  const error = errno => Object.assign(new Error(`error ${errno}`), { errno });
  for (const [errno, mysql, mariadb] of [
    [4025, 'DRIVER', 'CONSTRAINT'], [3819, 'CONSTRAINT', 'DRIVER'], [3572, 'LOCK_NOT_AVAILABLE', 'DRIVER'], [3024, 'CANCELED', 'DRIVER'],
    [4031, 'CONNECTION_LOST', 'DRIVER'], [1969, 'DRIVER', 'CANCELED'], [1062, 'DUPLICATE_KEY', 'DUPLICATE_KEY'], [1452, 'FOREIGN_KEY', 'FOREIGN_KEY'],
    [1213, 'DEADLOCK', 'DEADLOCK'], [1290, 'READ_ONLY', 'READ_ONLY'], [1205, 'CANCELED', 'CANCELED'],
  ]) {
    assert.equal(driverError('mysql', error(errno), 'mysql').code, mysql, `mysql ${errno}`);
    assert.equal(driverError('mysql', error(errno), 'mariadb').code, mariadb, `mariadb ${errno}`);
  }
});

async function withReservedSqliteSession(file, exercise) {
  const directory = mkdtempSync(join(tmpdir(), 'orm-ts-sqlite-cancel-'));
  const dsn = `sqlite://${join(directory, file)}`;
  let pool;
  let session;
  const release = () => {
    session?.release();
    session = undefined;
  };
  try {
    pool = openDriver(dsn, parseDsn(dsn), { size: 1, idleSize: 1, lifetimeMs: 0 }, 16);
    session = await pool.reserve();
    await exercise(pool, release);
  } finally {
    release();
    try { await pool?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

// Requirements: CFG-9. A pre-aborted SQLite statement does not wait behind a reserved connection.
caseTest('driver-cancel/sqlite/pre-aborted-while-queued', COMPUTE, async () => {
  await withReservedSqliteSession('pre-aborted.sqlite', async pool => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(pool.execute('SELECT 1', [], controller.signal, () => {}), error => error?.code === 'CANCELED');
    assert.equal(pool.stats().inUse, 1, 'cancellation must not release the held session');
  });
});

// Requirements: CFG-9. Aborting a queued SQLite statement removes its waiter without interrupting the holder.
caseTest('driver-cancel/sqlite/aborted-while-queued', COMPUTE, async () => {
  await withReservedSqliteSession('queued.sqlite', async (pool, release) => {
    const controller = new AbortController();
    const pending = pool.execute('SELECT 1', [], controller.signal, () => {});
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1, 'queued statement subscribes to cancellation');
    controller.abort();
    await assert.rejects(pending, error => error?.code === 'CANCELED');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'canceled waiter removes its listener');
    assert.equal(pool.stats().inUse, 1, 'cancellation must not release the held session');
    release();
    const result = await pool.execute('SELECT 1', [], undefined, () => {});
    assert.deepEqual(result.rows, [[1n]], 'pool remains usable after the holder releases');
  });
});
